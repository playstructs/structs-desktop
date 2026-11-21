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
  var SECTIONS = [['overview', 'Pirate'], ['acquisition', 'Join'], ['onboarding', 'Learn'], ['engagement', 'Stay'],
    ['leaving', 'Leaving'], ['data', 'Data']];
  var VIEWS = {
    onboarding: [['steps', 'Steps'], ['first', 'First moves'], ['after', 'After the tutorial'], ['runs', 'Runs']],
    data: [['health', 'Health'], ['guilds', 'Guilds'], ['record', 'Daily record'], ['distributions', 'Distributions'], ['dictionary', 'Dictionary']],
  };
  /* Sections that were folded in (2026-11-20), and where a saved card or an
   * issue's door that names one lands now. */
  var FOLDED = { trends: ['data', 'record'], guilds: ['data', 'guilds'], players: ['leaving', ''] };
  var FOLDED_VIEWS = { players: { signups: ['acquisition', ''], runs: ['onboarding', 'runs'], stopped: ['leaving', ''] } };
  function unfold(page, view) {
    var to = (FOLDED_VIEWS[page] || {})[view] || FOLDED[page];
    return to ? [to[0], to[1] || ''] : [page, view];
  }

  /* Words a ⌘K line may use for a section or a view: `TELEMETRY retention`. */
  var ALIASES = {
    overview: ['overview'], aarrr: ['overview'], pirate: ['overview'], home: ['overview'], funnel: ['overview'], weeks: ['overview'], stages: ['overview'],
    acquisition: ['acquisition'], join: ['acquisition'], signup: ['acquisition'], signups: ['acquisition'],
    onboarding: ['onboarding'], learn: ['onboarding'], tutorial: ['onboarding'], steps: ['onboarding', 'steps'], phases: ['onboarding', 'steps'], timing: ['onboarding', 'steps'],
    first: ['onboarding', 'first'], moves: ['onboarding', 'first'], activation: ['onboarding', 'first'],
    after: ['onboarding', 'after'], impact: ['onboarding', 'after'], outcome: ['onboarding', 'after'], runs: ['onboarding', 'runs'],
    engagement: ['engagement'], stay: ['engagement'], retention: ['engagement'], cohorts: ['engagement'], triangle: ['engagement'],
    leaving: ['leaving'], left: ['leaving'], leavers: ['leaving'], stuck: ['leaving'], captivated: ['leaving'], confused: ['leaving'], churn: ['leaving'],
    players: ['leaving'], explorer: ['leaving'], stopped: ['leaving'], recent: ['acquisition'],
    data: ['data'], health: ['data', 'health'], sources: ['data', 'health'], exclusions: ['data', 'health'], settings: ['data', 'health'],
    guilds: ['data', 'guilds'], trends: ['data', 'record'], record: ['data', 'record'], figures: ['data', 'record'], daily: ['data', 'record'],
    distributions: ['data', 'distributions'], stats: ['data', 'distributions'], definitions: ['data', 'dictionary'], dictionary: ['data', 'dictionary'], words: ['data', 'dictionary'],
  };

  /* The tutorial's phases, in play order; a step belongs to the first prefix it starts with. */
  var PHASES = [['signup', 'Signup'], ['orientation', 'Offer'], ['tutorial.intro', 'Intro'], ['tutorial.raid', 'Raid'], ['tutorial.rebuild', 'Rebuild'],
    ['tutorial.defend', 'Defend'], ['tutorial.first_attack', 'First attack'], ['tutorial.bomber', 'Bomber'], ['tutorial.free_play', 'Free play'],
    ['tutorial.new_cmd_ship', 'New Cmd Ship'], ['tutorial.end', 'End']];
  /* Fixed definitions, no longer settings: quit = idle 7 days, active = acted within 7 days. */
  var QUIT_HOURS = 168, ACTIVE_DAYS = 7;
  var SPLITS = [{ value: '', label: 'Split by: nothing' }, { value: 'interface', label: 'Split by: app' }, { value: 'guild', label: 'Split by: guild' },
    { value: 'version', label: 'Split by: tutorial version' }, { value: 'tutorial', label: 'Split by: tutorial outcome' }];
  /* One name per interface, everywhere it is drawn. */
  var IFACE = { 'structs-webapp': 'Web app', 'structs-desktop': 'Desktop app', none: 'No telemetry' };
  var DURATIONS = [['signup', 'Signup'], ['chain_wait', 'Chain wait'], ['to_offer', 'To offer'], ['decision', 'Decision'], ['tutorial', 'Tutorial'], ['total', 'Whole run']];
  var OUTCOMES = [['completed', 'Finished'], ['declined', 'Skipped'], ['left', 'Quit'], ['playing', 'In progress']];
  var OUTCOME_LABEL = { completed: 'Finished', declined: 'Skipped', left: 'Quit', playing: 'In progress', deciding: 'At offer' };
  /* A split by tutorial outcome wears the outcome colours, not swatches. */
  var OUTCOME_SEG = { finished: 'ob-seg-completed', quit: 'ob-seg-left', skipped: 'ob-seg-declined', none: 'ob-life-never' };
  var STATS = [['mined', 'Ore mined', 'ore'], ['refined', 'Alpha refined', 'alpha'], ['planets', 'Planets completed', 'count'],
    ['raids_initiated', 'Raids initiated', 'count'], ['raids_won', 'Raids won', 'count']];
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
    ['signups_started', 'Started signup', 'record', 'level', 'Awareness'], ['signed_up', 'Finished signups', 'record', 'level', 'Acquisition'],
    ['new', 'Joined', 'rebuilt', 'daily', 'Acquisition'], ['humans', 'Players', 'record', 'level', 'Acquisition'],
    ['tutorial_players', 'Tutorial players', 'record', 'level', 'Onboarding'], ['tutorial_completed', 'Tutorial finishers', 'record', 'level', 'Onboarding'],
    ['activations', 'Activated', 'rebuilt', 'daily', 'Activation'], ['activated_total', 'Activated, all time', 'rebuilt', 'level', 'Activation'],
    ['acted', 'Acted at least once', 'record', 'level', 'Activation'], ['mined', 'Mined at least once', 'record', 'level', 'Activation'],
    ['refined', 'Refined at least once', 'record', 'level', 'Activation'], ['raided', 'Initiated a raid at least once', 'record', 'level', 'Activation'],
    ['active_1d', 'Active today', 'record', 'level', 'Retention'], ['active_7d', 'Active this week', 'record', 'level', 'Retention'],
    ['active_30d', 'Active this month', 'record', 'level', 'Retention'], ['miners_7d', 'Mined this week', 'rebuilt', 'level', 'Retention'],
    ['refiners_7d', 'Refined this week', 'rebuilt', 'level', 'Retention'], ['raiders_7d', 'Initiated a raid this week', 'rebuilt', 'level', 'Retention'],
    ['replicants', 'Replicants', 'record', 'level', 'Population']];
  function trendDef(k) { return TRENDS.filter(function (m) { return m[0] === k; })[0]; }
  /* What each figure means: on hover wherever it is drawn, and listed on Data. */
  var DEFS = {
    'Started signup': 'Awareness: signup sessions started on any guild server — the earliest thing recorded. Unique visitors are not recorded yet.',
    'Joined': 'Human players created on chain. A joiner is counted from that moment.',
    'Visited': 'Awareness: unique visitors. No guild server records visits yet.',
    'Acted': 'Did anything on chain: lastAction set, or a mine, refine, raid or played day on record.',
    'Refined': 'Refined alpha at least once.',
    'Raided': 'Initiated a raid at least once.',
    'Refined or raided': 'Took either road towards activation. The two are drawn side by side: neither comes after the other.',
    'Newly activated': 'Players whose second of refine and raid landed in the window, whenever they joined.',
    'Played': 'A gameplay action that day: mine, refine, raid, attack, a defense change, a fleet move, or a struct build or move.',
    'Played this week': 'Played in the last 7 days, of everyone who joined (in the window, or that week).',
    'Week 1': 'Played on a day in the first week after joining (days 0–6), of everyone who joined that week.',
    'Week 2': 'Played on a day in the second week after joining, of everyone who joined that week.',
    'Week 4': 'Played on a day in the fourth week after joining, of everyone who joined that week.',
    'Week 8': 'Played on a day in the eighth week after joining, of everyone who joined that week.',
    'Signup recorded': 'Joiners whose own signup session was recorded by their guild\'s server.',
    'Not yet': 'The week\'s last joiner has not lived that long yet.',
    'Join date': 'Joined before 24 Sep 2026: the date is the indexer\'s floor, not the day they joined.',
    'Coverage': 'Of the players who joined since the first recorded signup, those whose signup session was recorded.',
    'Pulse': 'Calendar counts over the window. Never part of the funnel, never divided into it.',
    'Furthest reached': 'Everyone not active in the last 7 days, each counted once by the furthest stage they reached.',
    'Brought a player': 'Referral: not recorded by any guild yet.',
    'Active users': 'Activated players (refined and raided, ever) who did anything within the window.',
    'Anyone active': 'Every player who did anything on chain within the window, activated or not.',
    'Finished signups': 'Signup sessions that reached the end of signup (the employee record).',
    'Players': 'Human players on chain in scope: replicants and excluded players left out unless asked for.',
    'Test accounts': 'Accounts named like testers and test scripts make (T and a timestamp, ending in test or tester, QA, starting with Tutorial). Left out of every figure with the guilds\' excluded players.',
    'Excluded players': 'The guilds\' own exclusion lists plus test accounts by name.',
    'Activated': 'Refined alpha AND initiated a raid, with no deadline: the window decides how long they had. Dated at the later of the two firsts.',
    'Active': 'Did anything within the window: the latest of lastAction, a mine, a refine, a raid or a played day.',
    'Time to activate': 'Typical (median) time from joining to activation.',
    'Take-up': 'New players offered Combat Training who started it.',
    'Tutorial players': 'Unique players who reached the Combat Training offer, replays and logged-in runs included.',
    'Finished': 'Reached the end of Combat Training.',
    'Skipped': 'Declined Combat Training at the offer.',
    'Quit': 'Left Combat Training, or the offer, and stayed idle for 7 days.',
    'In progress': 'In Combat Training now: not idle for 7 days yet.',
    'Never acted': 'Joined and never did anything on chain.',
    'Churn': 'Did something, then went idle for 7 days.',
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
    'Cohort': 'Players by the week they joined (Monday UTC). Every count in a row is of that week\'s joiners; a stage the week is too young for reads not yet.',
    'Sample': 'New players\' own signup sessions, read from every guild: timings, skips and who stopped come from these.',
    'Change': 'Against the same length of time just before it. Shown only when the daily series reproduces the figure above it.',
    'Daily record': 'One row a day kept by this app while it runs: humans on chain across every guild. It follows the guild filter only, and starts when the app first recorded.',
    'Today of this month': 'Players active today as a share of those active in the last 30 days. Higher means players return more often.',
    'Last seen': 'Where each player is now, by when they last did anything on chain. Every player is in exactly one bucket.',
  };
  /* Which scope controls change each section. A control a section ignores is
   * dimmed there, so changing it never looks like a broken page. */
  var USES = {
    overview: ['iface', 'guild', 'compare', 'version'],
    acquisition: ['iface', 'guild', 'compare', 'version'],
    onboarding: ['iface', 'guild', 'compare', 'version'],
    engagement: ['iface', 'guild', 'compare', 'version'],
    leaving: ['iface', 'guild', 'compare', 'version'],
    data: ['guild', 'version'],
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
  /* "30% of signup starts", or "1 of 5 signup starts" while 5 is too few for a percentage. */
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
  /* The daily record's rows counted by its newest definitions (`def`): a
   * redefinition starts a new line rather than reading as a step. A row
   * stored before the rename says `activated` for what is now `acted`. */
  function currentRows(rows) {
    rows = rows || [];
    var v = rows.length ? rows[rows.length - 1].def || 1 : 1;
    return rows.filter(function (r) { return (r.def || 1) === v; }).map(function (r) { return 'acted' in r || !('activated' in r) ? r : Object.assign({ acted: r.activated }, r); });
  }
  /* One metric as [day, value] pairs, oldest first; missing days are absent. */
  function trendPoints(d, m) {
    var guild = (d.filters || {}).guild, out = [];
    if (m[2] === 'rebuilt') {
      var ts = d.trend_series || {}, days = ts.days || [], vals = (ts.series || {})[m[0]] || [];
      days.forEach(function (day, i) { if (vals[i] != null) out.push([day, vals[i]]); });
      return out;
    }
    currentRows(d.history).forEach(function (r) { var v = trendValue(r, m[0], guild); if (v != null) out.push([r.day, v]); });
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
    if (days === 'all' || !s) return null;
    /* Telemetry began inside the window: everything it ever counted is the
     * window's. Otherwise the longest stretch the record can answer. */
    var began = telemetryBegan(seg);
    if (began && s.all && Date.parse(began) >= Date.now() - Number(days) * 864e5) return { started: s.all.started, signed_up: s.all.signed_up, partial: null, since: began };
    var o = s.oldest || s.prior;
    return o ? { started: o.started, signed_up: o.signed_up, partial: o.day } : null;
  }
  /* The first recorded signup: when signup telemetry began. */
  function telemetryBegan(seg) { return (seg && seg.coverage && seg.coverage.since) || null; }
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
      ['Test accounts', int(((c.tests || {}).players || []).length) + ' by name', (c.tests || {}).left_out === false ? 'included' : 'left out', all, null, !!p.refreshed_ms || settled],
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
    if (failing.length) out.push({ level: 'issue', title: 'Guilds failing', where: names(failing), count: plural(sum(failing, function (x) { return x.players; }), 'player', 'players'), page: 'data', view: 'guilds', fix: 'Their API answers with an error: open the guild row for the message.' });
    /* Players are joining where nothing records their signup: the biggest gap in every funnel. */
    var cov = ((d.segments || [])[0] || {}).coverage, silent = ((cov && cov.guilds) || []).filter(function (x) { return x.joined > 0 && !x.tracked; });
    if (silent.length) out.push({ level: 'issue', title: 'Guilds send no telemetry', where: names(silent.map(function (x) { return g.filter(function (y) { return y.id === x.guild; })[0] || { id: x.guild }; })),
      count: int(sum(silent, function (x) { return x.joined; })) + ' of ' + int(cov.joined) + ' joined since ' + shortDay(cov.since), page: 'data', view: 'guilds', fix: 'Their players\' signups and tutorial runs are not recorded: the guild must publish its API with onboarding telemetry.' });
    var lost = g.filter(function (x) { return x.no_player > 0; }), noPlayer = sum(g, function (x) { return x.no_player; });
    if (noPlayer) out.push({ level: 'notice', title: 'Runs with no player', where: names(lost), count: int(noPlayer) + ' of ' + int(sum(g, function (x) { return x.runs; })) + ' runs', page: 'onboarding', view: 'runs', fix: 'The run never recorded who played: the launch message was lost. Older app versions do this.' });
    var dark = g.filter(function (x) { return x.status === 'no_api'; });
    dark = dark.filter(function (x) { return !silent.some(function (y) { return y.guild === x.id; }); });
    if (dark.length) out.push({ level: 'notice', title: 'Guilds with no API', where: names(dark), count: plural(sum(dark, function (x) { return x.players; }), 'player', 'players') + ' unseen', page: 'data', view: 'guilds', fix: 'These guilds publish no API, so their signups and tutorial are not counted.' });
    var days = (d.history || []).length, c0 = d.crawl || {};
    if (reconcileRows(d).some(function (r) { return !r.ok; })) out.push({ level: 'notice', title: 'Sources disagree', where: reconcileRows(d).filter(function (r) { return !r.ok; }).map(function (r) { return r.label; }).join(' · '), count: '', page: 'data', fix: 'The chain\'s tables and the daily record give different figures for the same window: see Do the sources agree? on Data.' });
    if (days < 7 && days > 0) out.push({ level: 'notice', title: 'Daily record is short', where: days ? 'Since ' + d.history[0].day : 'Nothing recorded', count: plural(days, 'day', 'days'), page: 'data', view: 'record', fix: 'The app records one row a day while it runs; changes over 7 or 30 days need that many.' });
    return out;
  }
  /* Players the guild list leaves out: no guild on chain. Only countable when
   * the page shows the same population as the guild rows. */
  function unguilded(d) {
    var f = d.filters || {}, segs = d.segments || [];
    if (segs.length !== 1 || f.guild || f.interface || f.activity) return 0;
    return Math.max(0, (segs[0].players || 0) - sum(d.guilds || [], function (g) { return g.players; }));
  }

  // ── Card params ──
  function argsOf(p) {
    var a = { idleHours: QUIT_HOURS, activeDays: ACTIVE_DAYS,
      filters: { interface: p.iface || null, guild: p.guild || null, activity: null, replicants: p.reps === '1', compare: SPLITS.some(function (x) { return x.value && x.value === p.compare; }) ? p.compare : null,
        include_excluded: p.excl === '1' } };
    if (p.version) a.version = p.version;
    return a;
  }
  function pageOf(p) { var pg = unfold(p.page, p.view)[0]; return SECTIONS.some(function (s) { return s[0] === pg; }) ? pg : 'overview'; }
  function viewOf(p) {
    var list = VIEWS[pageOf(p)], v = FOLDED[p.page] ? unfold(p.page, p.view)[1] : p.view;
    if (!list) return null;
    return list.some(function (x) { return x[0] === v; }) ? v : list[0][0];
  }
  var SPLIT_WORDS = { interface: 'interface', app: 'interface', guild: 'guild', version: 'version', tutorial: 'tutorial', outcome: 'tutorial' };
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
      var win = { '24h': '1', '1d': '1', '7d': '7', '30d': '30', all: 'all', alltime: 'all' }[w];
      if (win) { out.win = win; continue; }
      if (/^0-\d+$/.test(w)) { out.guild = w; continue; }
      if (w === 'guild' && nx && /^0-\d+$/.test(nx)) { out.guild = nx; i++; continue; }
      if ((w === 'split' || w === 'by' || w === 'compare') && nx && SPLIT_WORDS[nx.replace(/s$/, '')]) { out.compare = SPLIT_WORDS[nx.replace(/s$/, '')]; i++; continue; }
      if (w === 'replicants') { out.reps = '1'; continue; }
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
    if (p.win && p.win !== '30') parts.push(p.win === '1' ? '24h' : p.win === 'all' ? 'all' : p.win + 'd');
    if (p.guild) parts.push('guild', p.guild);
    if (p.compare) parts.push('split', p.compare);
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
    if (step) head.appendChild(actionBtn('All stopped', function () { ctx.st.stepFilter = step; ctx.go('leaving'); }, 'all_stopped'));
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
  // ── Shared KPI figures (the same definition wherever they appear) ──
  function seriesOf(s) { return (s.pirate_series && s.pirate_series.series) || {}; }
  function histSeries(d, key) { return isPlain(d) ? ((d.history_series || {}).series || {})[key] : null; }
  var K = {
    opens: function (ctx) {
      return { key: 'opens', stage: 'Awareness', label: 'Started signup', count: true, go: function () { ctx.go('acquisition'); }, get: function (s) {
        var x = srvWin(s, ctx.win), inc = increments(histSeries(ctx.d, 'signups_started') || []);
        return { value: int(x && x.started), raw: x && x.started, scope: x && x.partial ? 'since ' + shortDay(x.partial) : null, delta: x && !x.partial ? deltaFor(x.started, inc, ctx.win, 'daily') : null, spark: sparkOf(ctx.d, s, 'h:signups_started', isPlain(ctx.d)) };
      } };
    },
    finished: function (ctx) {
      return { key: 'finished_signups', stage: 'Acquisition', label: 'Finished signups', count: true, go: function () { ctx.go('acquisition'); }, get: function (s) {
        var x = srvWin(s, ctx.win), inc = increments(histSeries(ctx.d, 'signed_up') || []);
        return { value: int(x && x.signed_up), raw: x && x.signed_up, sub: x ? shareOf(x.signed_up, x.started, 'signup starts') : null, scope: x && x.partial ? 'since ' + shortDay(x.partial) : null,
          delta: x && !x.partial ? deltaFor(x.signed_up, inc, ctx.win, 'daily') : null, spark: sparkOf(ctx.d, s, 'h:signed_up', isPlain(ctx.d)) };
      } };
    },
    newPlayers: function (ctx) {
      return { key: 'new', stage: 'Acquisition', label: 'Joined', count: true, def: DEFS.Joined, go: function () { ctx.go('acquisition'); }, get: function (s) {
        var v = winOf(s, ctx.win).new;
        return { value: int(v), raw: v, delta: deltaFor(v, seriesOf(s).new, ctx.win, 'daily'), spark: sparkOf(ctx.d, s, 'p:new') };
      } };
    },
    activated: function (ctx) {
      return { key: 'activated', stage: 'Activation', label: 'Newly activated', cls: 'ok', count: true, def: DEFS['Newly activated'], go: function () { ctx.go('onboarding', 'first'); }, get: function (s) {
        var x = winOf(s, ctx.win);
        return { value: int(x.activated), raw: x.activated, sub: x.cohort != null ? int(x.cohort) + ' of them joined in the window' : null, delta: deltaFor(x.activated, seriesOf(s).activations, ctx.win, 'daily'), spark: sparkOf(ctx.d, s, 'p:activations') };
      } };
    },
    active: function (ctx) {
      return { key: 'active', stage: 'Retention', label: activeName(ctx.win), cls: 'ok', def: DEFS.Active, go: function () { ctx.go('engagement'); }, get: function (s) {
        var x = winOf(s, ctx.win), key = { 1: 'dau', 7: 'wau', 30: 'mau' }[ctx.win];
        return { value: int(x.active), raw: x.active, sub: shareOf(x.active, allOf(s).players, 'players'), delta: deltaFor(x.active, histSeries(ctx.d, key), ctx.win, 'level'), spark: sparkOf(ctx.d, s, 'h:' + key, isPlain(ctx.d)) };
      } };
    },
    activeUsers: function (ctx) {
      return { key: 'active_users', stage: 'Retention', label: 'Active users', count: true, def: DEFS['Active users'], go: function () { ctx.go('engagement'); }, get: function (s) {
        var x = winOf(s, ctx.win), a = allOf(s);
        return { value: int(x.active_activated), raw: x.active_activated, sub: shareOf(x.active_activated, a.activated, 'activated players') };
      } };
    },
    players: function (ctx) {
      return { key: 'players', stage: 'Population', label: 'Players', scope: 'now', count: true, def: DEFS.Players, go: function () { ctx.go('engagement'); }, get: function (s) {
        var v = allOf(s).players != null ? allOf(s).players : s.players;
        var who = s.key === 'replicant' ? 'replicants' : (ctx.d.filters || {}).replicants ? 'players' : 'humans';
        return { value: int(v), raw: v, sub: who + ' on chain', delta: deltaFor(v, seriesOf(s).players_total, ctx.win, 'level'), spark: (seriesOf(s).players_total || []).slice(-30).filter(function (x) { return x != null; }) };
      } };
    },
    stickiness: function (ctx) {
      return { key: 'stickiness', stage: 'Retention', label: 'Today of this month', scope: 'now', go: function () { ctx.go('engagement'); }, get: function (s) {
        var sk = (s.pirate || {}).stickiness || {};
        return { value: pct(ratio(sk.dau, sk.mau)), sub: int(sk.dau) + ' today of ' + int(sk.mau) + ' this month' };
      } };
    },
  };

  // ── PIRATE: the funnel by who joined in the window, the pulse, the weeks ──
  /* The owner's definitions (2026-11-20): activated = refined AND raided,
   * with no deadline (the window is the time context); retention counts
   * everyone who joined; played = any gameplay action that day. */
  function cohortWin(seg, win) {
    var c = seg && seg.pirate_cohorts;
    return c ? (c.windows || []).filter(function (w) { return String(w.days) === String(win); })[0] || null : null;
  }
  /* The funnel's rows for one segment and window, in two groups that are
   * never divided into each other: signup sessions, then the players who
   * joined in the window. Every row names the row it is a share of (`of`):
   * the row above, or `joined` for retention, which counts every joiner. */
  function pirateRows(seg, win) {
    var x = srvWin(seg, win), c = cohortWin(seg, win);
    var v = function (k) { return c ? c[k] : null; };
    var rows = [
      { group: 'sessions', key: 'visited', stage: 'Awareness', label: 'Visited', value: null, of: null, unrecorded: true },
      { group: 'sessions', key: 'started', stage: 'Awareness', label: 'Started signup', value: x ? x.started : null, of: null, unit: 'sessions' },
      { group: 'sessions', key: 'signed', stage: 'Acquisition', label: 'Finished signup', value: x ? x.signed_up : null, of: 'started', unit: 'sessions' },
      { group: 'players', key: 'joined', stage: 'Acquisition', label: 'Joined', value: v('joined'), of: null },
      { group: 'players', key: 'acted', stage: 'Activation', label: 'Acted', value: v('acted'), of: 'joined' },
      { group: 'players', key: 'refined_or_raided', stage: 'Activation', label: 'Refined or raided', value: v('refined_or_raided'), of: 'acted', parts: [['Refined', v('refined')], ['Raided', v('raided')]] },
      { group: 'players', key: 'activated', stage: 'Activation', label: 'Activated', value: v('activated'), of: 'refined_or_raided', what: 'refined and raided' },
      { group: 'every', key: 'playing', stage: 'Retention', label: 'Played this week', value: v('playing'), of: 'joined' },
      { group: 'every', key: 'referred', stage: 'Referral', label: 'Brought a player', value: null, of: 'joined', unrecorded: true },
    ];
    var by = {};
    rows.forEach(function (r) { by[r.key] = r; r.missing = r.value == null; r.ofValue = r.of && by[r.of] ? by[r.of].value : null; r.ofLabel = r.of && by[r.of] ? by[r.of].label : null; });
    return rows;
  }
  /* "refined 6 · raided 9 · both 2": the two roads and where they overlap. */
  function partsWords(r) {
    var a = r.parts[0][1], b = r.parts[1][1];
    var w = r.parts.map(function (p) { return p[0].toLowerCase() + ' ' + int(p[1]); });
    if (a != null && b != null && r.value != null && a + b > r.value) w.push('both ' + int(a + b - r.value));
    return w.join(' · ');
  }
  /* "36% of acted" — or "3 of 10 acted" while 10 is too few for a percentage. */
  function ofWords(n, total, word) {
    if (n == null || !(total > 0)) return null;
    return total >= SMALL_N ? pct(n / total) + ' of ' + word : int(n) + ' of ' + int(total) + ' ' + word;
  }
  function groupScope(seg, win, group) {
    if (group === 'sessions') {
      var x = srvWin(seg, win), since = telemetryBegan(seg) || (seg.pirate_server || {}).since;
      return 'Signup sessions · ' + (win === 'all' ? (since ? 'since ' + shortDay(since) : 'all recorded') : x && x.partial ? 'since ' + shortDay(x.partial) + ', the oldest reading' : x && x.since ? 'since ' + shortDay(x.since) + ', when telemetry began' : 'last ' + WIN_WORD[win]);
    }
    var c = cohortWin(seg, win);
    if (group === 'every') return 'Of everyone who joined' + (c ? ' · ' + int(c.joined) : '');
    if (!c) return 'Players who joined';
    return 'Joined ' + (win === 'all' ? 'since ' + shortDay(c.from) + ' (exact join dates)' : String(win) === '1' ? 'in the last day' : shortDay(c.from) + ' – today') + ' · ' + plural(c.joined, 'player', 'players');
  }
  function pirateFunnel(ctx, seg) {
    var rows = pirateRows(seg, ctx.win), g = H.el('div', 'ob-fg ob-pf');
    var joinedN = (rows.filter(function (r) { return r.key === 'joined'; })[0] || {}).value || 0;
    ['sessions', 'players', 'every'].forEach(function (group) {
      var mine = rows.filter(function (r) { return r.group === group; });
      /* Every joiner's group is drawn against the joiners. */
      var top = group === 'every' ? joinedN : mine.reduce(function (m, r) { return Math.max(m, r.value || 0); }, 0);
      var head = H.el('div', 'ob-fg-group');
      head.setAttribute('data-group', group);
      head.appendChild(H.el('span', 'ob-sub', groupScope(seg, ctx.win, group)));
      g.appendChild(head);
      mine.forEach(function (r) {
        var row = H.el('div', 'ob-fg-row' + (r.missing ? ' is-missing' : ''));
        row.setAttribute('data-funnel', r.key);
        if (r.of) row.setAttribute('data-of', r.of);
        row.title = DEFS[r.label] || '';
        var name = H.el('div', 'ob-fg-name');
        name.appendChild(H.el('span', 'ob-fg-stage', r.stage));
        name.appendChild(H.el('span', 'ob-fg-label', r.label));
        var what = r.unrecorded ? 'not recorded' : r.missing ? 'not recorded for this group' : r.parts ? partsWords(r)
          : [r.what, ofWords(r.value, r.ofValue, (r.ofLabel || '').toLowerCase()) || (r.unit || 'players')].filter(Boolean).join(' · ');
        name.appendChild(H.el('span', 'ob-sub ob-fg-what', what));
        row.appendChild(name);
        var track = H.el('div', 'ob-fg-track');
        var stageCls = 'ob-fg-' + r.stage.toLowerCase();
        if (r.parts && !r.missing) {
          /* Two roads, side by side: neither is a step after the other. */
          var both = H.el('div', 'ob-fg-parts');
          r.parts.forEach(function (p, i) {
            var b = H.el('div', 'ob-fg-bar ' + stageCls + ' ob-fg-part-' + i);
            b.setAttribute('data-part', p[0].toLowerCase());
            b.style.width = p[1] > 0 ? Math.max(1, (ratio(p[1], top) || 0) * 100) + '%' : '0';
            both.appendChild(b);
          });
          track.appendChild(both);
        } else {
          var bar = H.el('div', 'ob-fg-bar ' + stageCls);
          bar.style.width = r.missing ? '100%' : r.value > 0 ? Math.max(1, (ratio(r.value, top) || 0) * 100) + '%' : '0';
          if (r.missing) bar.appendChild(H.el('span', 'ob-fg-note', 'not recorded'));
          track.appendChild(bar);
        }
        row.appendChild(track);
        var num = H.el('div', 'ob-fg-num');
        num.appendChild(H.el('span', 'ob-fg-value', r.missing ? '—' : int(r.value)));
        if (!r.missing && r.ofValue > 0 && r.ofValue >= SMALL_N) num.appendChild(H.el('span', 'ob-sub', pct(r.value / r.ofValue)));
        row.appendChild(num);
        g.appendChild(row);
      });
    });
    return g;
  }
  function funnelChips(ctx) {
    var out = [];
    ctx.segs.forEach(function (s) {
      var c = cohortWin(s, ctx.win);
      if (c && c.ledger_unread) out.push(chip(int(c.ledger_unread) + ' not read yet', 'Acted, but their ledger is not read yet: mined, refined and activated are not known for them.'));
    });
    return out.slice(0, 1);
  }
  function pirateBlock(ctx) {
    var segs = ctx.segs;
    var b = block('Pirate funnel', { key: 'funnel', scope: ctx.win === 'all' ? 'All time' : 'Last ' + WIN_WORD[ctx.win], extra: funnelChips(ctx),
      def: 'Signup sessions, then the players who joined in the window. Every stage is counted over the same joiners, so far.' });
    if (segs.length === 1) { b.appendChild(pirateFunnel(ctx, segs[0])); return b; }
    var cols = H.el('div', 'ob-fg-split');
    segs.forEach(function (s, i) {
      var col = H.el('div', 'ob-fg-col');
      col.appendChild(segLabel(s, i));
      col.appendChild(pirateFunnel(ctx, s));
      cols.appendChild(col);
    });
    b.appendChild(cols);
    return b;
  }
  /* Telemetry saw N of the M who joined since it began; a guild that sent none is named. */
  function coverageLine(ctx) {
    var tags = guildTags(ctx.d), segs = ctx.segs, box = H.el('div', 'ob-coverage');
    box.setAttribute('data-block', 'coverage');
    segs.forEach(function (s, i) {
      var c = s.coverage;
      if (!c || !c.joined) return;
      var line = H.el('span', 'ob-coverage-line');
      if (segs.length > 1) line.appendChild(segLabel(s, i));
      line.appendChild(H.el('span', 'ob-v', 'Telemetry saw ' + int(c.tracked) + ' of ' + int(c.joined)));
      line.appendChild(sub('joined since ' + shortDay(c.since)));
      (c.guilds || []).filter(function (g) { return g.joined > 0 && !g.tracked; }).sort(function (a, b) { return b.joined - a.joined; }).forEach(function (g) {
        line.appendChild(sub('· ' + (tags[g.guild] || g.guild) + ' sent none (' + int(g.joined) + ')'));
      });
      box.appendChild(line);
    });
    if (!box.firstChild) return null;
    box.appendChild(link('Coverage', function () { ctx.go('data'); }, 'ob-coverage-door'));
    box.title = DEFS.Coverage;
    return box;
  }
  /* Calendar counts over the window: never inside the funnel, never divided into it. */
  function pulseDefs(ctx) {
    if (ctx.win !== 'all') return [K.newPlayers(ctx), K.active(ctx), K.activeUsers(ctx), K.activated(ctx)];
    return [
      { key: 'new', stage: 'Acquisition', label: 'Joined', count: true, def: DEFS.Joined, get: function (s) { var a = allOf(s); return { value: int(a.players), raw: a.players, sub: 'humans on chain' }; } },
      { key: 'active', stage: 'Activation', label: 'Ever acted', count: true, def: DEFS.Acted, get: function (s) { var a = allOf(s); return { value: int(a.acted), raw: a.acted, sub: shareOf(a.acted, a.players, 'players') }; } },
      { key: 'activated', stage: 'Activation', label: 'Ever activated', cls: 'ok', count: true, def: DEFS.Activated, get: function (s) { var a = allOf(s); return { value: int(a.activated), raw: a.activated, sub: shareOf(a.activated, a.players, 'players') }; } },
    ];
  }
  var WEEK_COLS = [['joined', 'Joined'], ['acted', 'Acted'], ['refined', 'Refined'], ['raided', 'Raided'], ['activated', 'Activated'],
    ['retained_w1', 'Week 1'], ['retained_w2', 'Week 2'], ['retained_w4', 'Week 4', true], ['playing', 'Played this week', true]];
  /* One row per join week: the same funnel, so a better week reads as a better row. */
  function weekTable(seg) {
    var t = grid('ob-weeks', [{ label: 'Week of', k: 't', w: 'minmax(9ch, .8fr)', def: 'Joined in the week starting (Monday UTC).' }].concat(WEEK_COLS.map(function (c) { return { label: c[1], k: 'n', w: 'minmax(' + Math.max(6, c[1].length) + 'ch, .55fr)', opt: !!c[2], def: DEFS[c[1]] }; })));
    var weeks = ((seg.pirate_cohorts || {}).weeks || []).slice().reverse();
    weeks.forEach(function (wk) {
      var name = cell((wk.exact ? '' : '≈ ') + shortDay(wk.week), 'ob-step', wk.exact ? null : DEFS['Join date']);
      addRow(t, [name].concat(WEEK_COLS.map(function (c) {
        var v = wk[c[0]];
        if (v == null) return cell('not yet', 'ob-sub ob-notyet', DEFS['Not yet']);
        if (c[0] === 'joined') return cell(int(v), 'ob-v');
        var n = /^retained_w(\d)$/.exec(c[0]), part = n && beforeFeed(seg, wk.week, Number(n[1]));
        var tip = int(v) + ' of ' + int(wk.joined) + (wk.joined >= SMALL_N ? ' · ' + pct(v / wk.joined) : '');
        return cell(int(v), 'ob-v' + (part ? ' is-partial' : ''), part ? tip + ' · ' + feedNote(seg) : tip);
      })), { data: { week: wk.week }, cls: wk.joined ? '' : 'is-empty' });
    });
    return t;
  }
  /* Three doors: the biggest leak, the learning gap, and who came back. */
  var LEFT_LABEL = { never_acted: 'Never acted on chain', acted_only: 'Acted, never mined', mined_only: 'Mined, never refined or raided', refined_no_raid: 'Refined, never raided',
    raided_no_refine: 'Raided, never refined', activated: 'Activated, then left', not_read: 'Not read yet' };
  var LEFT_ORDER = ['never_acted', 'acted_only', 'mined_only', 'refined_no_raid', 'raided_no_refine', 'activated', 'not_read'];
  function doorDefs(ctx, seg) {
    var out = [], l = seg.left, imp = (ctx.d.tutorial_impact || []).filter(function (r) { return r.key === 'finished'; })[0];
    if (l && l.left) {
      var big = LEFT_ORDER.filter(function (k) { return k !== 'not_read'; }).sort(function (a, b) { return (l.furthest[b] || 0) - (l.furthest[a] || 0); })[0];
      out.push({ key: 'door_leaving', stage: 'Biggest leak', label: LEFT_LABEL[big], value: int(l.furthest[big]), sub: shareOf(l.furthest[big], l.left, 'who left'), scope: 'all time', go: function () { ctx.go('leaving'); } });
    }
    if (imp && imp.players) out.push({ key: 'door_learn', stage: 'Learn', label: 'Tutorial finishers who raided', value: int(imp.raided), sub: shareOf(imp.raided, imp.players, 'finishers'), scope: telemetryBegan(seg) ? 'since ' + shortDay(telemetryBegan(seg)) : null, go: function () { ctx.go('onboarding', 'after'); } });
    var wk = ((seg.pirate_cohorts || {}).weeks || []).filter(function (w) { return w.retained_w2 != null && w.joined > 0; }).pop();
    if (wk) out.push({ key: 'door_stay', stage: 'Stay', label: 'Played in week 2', value: int(wk.retained_w2), sub: ofWords(wk.retained_w2, wk.joined, 'who joined ' + shortDay(wk.week)), go: function () { ctx.go('engagement'); } });
    return out;
  }
  function doorsBlock(ctx) {
    if (ctx.segs.length !== 1) return null;
    var defs = doorDefs(ctx, ctx.segs[0]);
    if (!defs.length) return null;
    var hud = H.el('div', 'ob-hud ob-pirate-doors');
    hud.setAttribute('data-block', 'doors');
    defs.forEach(function (k) { hud.appendChild(tile({ key: k.key, stage: k.stage, label: k.label, value: k.value, sub: k.sub, scope: k.scope, go: k.go })); });
    return hud;
  }
  var PIRATE_WINDOWS = WINDOWS.concat([{ key: 'all', label: 'All time' }]);
  function viewOverview(ctx) {
    var d = ctx.d, segs = ctx.segs, box = H.el('div', 'ob-view');
    if (!segs.length || !segs[0].pirate_cohorts) {
      box.appendChild(emptyOr(d, 'No players read yet'));
      var iss = issuesOf(d).filter(function (x) { return x.level === 'issue'; });
      if (iss.length && !reading(d)) box.appendChild(actionBtn(plural(iss.length, 'issue', 'issues') + ' · open Data', function () { ctx.go('data'); }, 'to_data'));
      return box;
    }
    var head = H.el('div', 'ob-kpi-head ob-overview-head');
    var strip = H.navStrip(PIRATE_WINDOWS, ctx.win, function (k) { ctx.set({ win: k }); });
    strip.classList.add('ob-windows');
    head.appendChild(strip);
    box.appendChild(head);
    var cov = coverageLine(ctx);
    if (cov) box.appendChild(cov);
    box.appendChild(kpi(ctx, pulseDefs(ctx), chip(ctx.win === 'all' ? 'Pulse · all time' : 'Pulse · last ' + WIN_WORD[ctx.win], DEFS.Pulse), ctx.win === 'all' ? 'all time' : WIN_WORD[ctx.win]));
    box.appendChild(pirateBlock(ctx));
    segs.forEach(function (s, i) {
      var wb = block(segs.length > 1 ? 'By join week · ' + segName(s) : 'By join week', { key: 'weeks', scope: 'Join weeks · Monday UTC', def: DEFS.Cohort });
      wb.appendChild(weekTable(s));
      box.appendChild(wb);
    });
    var doors = doorsBlock(ctx);
    if (doors) box.appendChild(doors);
    return box;
  }

  /* A section's own figures from Trends: the same rows, filtered to its stage. */
  function trendsBlock(ctx, stages, title) {
    var rows = TRENDS.filter(function (m) { return stages.indexOf(m[4]) >= 0; }).map(function (m) { return [m, trendPoints(ctx.d, m)]; }).filter(function (r) { return r[1].length; });
    if (!rows.length) return null;
    var f = ctx.d.filters || {};
    var ignores = f.compare ? 'not split' : (f.interface || f.activity || f.replicants) ? 'not filtered' : '';
    var b = block(title || 'Daily record', { key: 'trends', noTag: true, scope: 'Humans, ' + (OB.tag || 'every guild') + (ignores ? ' · ' + ignores : ''), def: DEFS['Daily record'], chart: function () { openChart(rows.slice(0, 6).map(function (r) { return r[0][0]; })); },
      extra: [actionBtn('Daily record', function () { ctx.go('data', 'record'); }, 'trends')] });
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

  // ── JOIN: from opening signup to a player ──
  function viewAcquisition(ctx) {
    var d = ctx.d, box = H.el('div', 'ob-view');
    var segs = ctx.segs.filter(function (s) { return s.signup; });
    if (!segs.length) {
      var f = d.filters || {};
      if (f.compare === 'tutorial') box.appendChild(H.stateBlock('empty', 'The tutorial comes after signup'));
      else box.appendChild(emptyOr(d, 'No signups recorded'));
      if ((d.recent || []).length) box.appendChild(playerList(ctx, 'signups'));
      return box;
    }
    var sctx = Object.assign({}, ctx, { segs: segs });
    box.appendChild(kpi(sctx, [K.opens(ctx), K.finished(ctx), K.newPlayers(ctx),
      { key: 'dropoff', label: 'Never finished', cls: 'bad', scope: 'all time', def: 'Signup sessions that stopped before the end.', get: function (s) { var h = headline(s); return { value: int(h.started - h.signed), sub: share(h.started - h.signed, h.started) + ' of ' + int(h.started) + ' starts' }; } },
      { key: 'signup_time', label: 'Signup takes', scope: 'all time', def: DEFS.Median, get: function (s) { var x = (s.durations || {}).signup; return { value: durWords(x && x.p50), sub: x ? 'typical · one in ten over ' + durWords(x.p90) : null }; } },
    ], windowStrip(ctx), WIN_WORD[ctx.win]));
    var b = block('Signup funnel', { key: 'funnel', scope: 'All time', scopeDef: 'The guild servers keep no date range for their funnels.', chart: function () { openChart(['signups_started', 'signed_up']); } });
    b.appendChild(segs.length === 1 ? funnelSingle(ctx, segs[0], segs[0].signup.steps || [], false) : funnelCompare(segs, function (s) { return s.signup.steps; }));
    box.appendChild(b);
    var tb = trendsBlock(ctx, ['Awareness', 'Acquisition']);
    if (tb) box.appendChild(tb);
    box.appendChild(playerList(ctx, 'signups'));
    return box;
  }

  // ── ONBOARDING: Combat Training ──
  function onboardingKpi(ctx) {
    var d = ctx.d;
    /* The record keeps every guild's totals: a filtered or split page has no change to show (B6). */
    function wk(key) { return isPlain(d) && ctx.segs.length === 1 ? deltaOf(increments(histSeries(d, key) || ((d.history || []).map(function (r) { return r.server ? r.server[key] : null; }))), 7, 'daily') : null; }
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
  /* How far unique players got: the servers' count, replays and logged-in runs in. */
  function playerFunnel(ctx, seg, rows) {
    var d = ctx.d;
    var stopTop = worstRates(rows.slice(0, -1), function (r) { return r.reached; }, function (r) { return r.furthest; }, FLAG_TOP);
    var t = grid('ob-steps', [{ label: 'Step', k: 't', w: 'minmax(18ch, 1.6fr)' }, { label: '', k: 'b', opt: true }, { label: 'Reached', k: 'n' }, { label: 'Kept', k: 'n', opt: true },
      { label: 'Stopped', k: 'n', opt: true }, { label: 'Stop rate', k: 'n' }, { label: 'Median', k: 'n', def: 'Typical time until the next step.' }]);
    rows.forEach(function (r, i) {
      var last = i === rows.length - 1, flag = stopTop.indexOf(r.key) >= 0, w = dwellOf(seg, r.key);
      var row = addRow(t, [cell(stepLabel(r.key), 'ob-step', r.key), bar(r.retained), int(r.reached), rows[0].reached >= SMALL_N ? pct(r.retained) : '—',
        cell(last ? '—' : int(r.furthest), flag ? 'is-bad' : ''), cell(last ? '—' : pct1(ratio(r.furthest, r.reached)), flag ? 'is-bad' : ''), cell(w ? dur(w.p50) : '—', 'ob-sub')], { data: { step: r.key } });
      var who = d.stopped && d.stopped[r.key];
      if (who) drill(t, row, r.key, function () { return whoList(ctx, who, r.key); });
    });
    return t;
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
      var wt = grid('ob-run-weeks', [{ label: '', k: 't', w: 'minmax(12ch, 1fr)' }, { label: 'Runs', k: 'n' }, { label: 'Finished', k: 'n' }, { label: 'Quit', k: 'n' }, { label: 'In progress', k: 'n', opt: true }, { label: 'No player', k: 'n', opt: true }]);
      weeks.forEach(function (x) { addRow(wt, [cell(x.label, 'ob-step'), int(x.runs), stack(int(x.completed), ofShare(x.completed, x.runs)), stack(int(x.left), ofShare(x.left, x.runs)), int(x.playing), int(x.no_player)], { data: { week: x.label } }); });
      wb.appendChild(wt);
      box.appendChild(wb);
    }
    var bc = block('First run against later runs', { key: 'by_run', scope: 'All time' });
    bc.appendChild(runCompare(segs));
    box.appendChild(bc);
    box.appendChild(playerList(ctx, 'runs'));
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
  // ── LEARN: does Combat Training lead to a first real refine and raid? ──
  /* How long each part of signup and the tutorial takes. */
  function durationsBlock(ctx) {
    var segs = ctx.segs;
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
    return b;
  }
  /* One step table, signup to the end: by unique players, or by the sample of
   * new signups' sessions (phases that open into their steps), time a column. */
  function viewLearnSteps(ctx) {
    var d = ctx.d, segs = ctx.segs, box = H.el('div', 'ob-view');
    if (segs.length > 1) {
      var pc = block('Steps · sample of new signups, by phase', { key: 'phases', scope: 'All time', def: DEFS.Sample });
      pc.appendChild(funnelCompare(segs, phaseSteps, 'Phase'));
      box.appendChild(pc);
      box.appendChild(durationsBlock(ctx));
      return box;
    }
    var s = segs[0], tt0 = tutorialOf(s), steps = s.player_steps || [], phases = phaseRows(s);
    var ob = block('Outcomes · ' + int(tt0.offered) + (tt0.unique ? ' unique players' : ' players'), { key: 'outcomes', scope: 'All time', copy: false });
    ob.appendChild(outcomeStrip(tt0));
    box.appendChild(ob);
    var by = steps.length && ctx.st.count !== 'sessions' ? 'players' : 'sessions';
    var pick = H.navStrip([{ key: 'players', label: 'Players' }, { key: 'sessions', label: 'Sessions' }].filter(function (x) { return x.key === 'sessions' || steps.length; }), by, function (k) { ctx.st.count = k; ctx.redraw(); });
    pick.classList.add('ob-count');
    if (by === 'players') {
      var up = block('Steps · ' + int(steps[0].reached) + ' unique players', { key: 'steps', scope: 'All time', extra: [pick], def: DEFS['Tutorial players'] });
      up.appendChild(playerFunnel(ctx, s, steps));
      box.appendChild(up);
    } else if (phases.length) {
      var pb = block('Steps · sample of ' + int(phases[0].reached) + ' new signups, by phase', { key: 'phases', scope: 'All time', extra: steps.length ? [pick] : [], def: DEFS.Sample });
      pb.appendChild(phaseFunnel(ctx, s, phases));
      box.appendChild(pb);
    }
    box.appendChild(durationsBlock(ctx));
    var tb = trendsBlock(ctx, ['Onboarding']);
    if (tb) box.appendChild(tb);
    return box;
  }
  /* "18 h", "2.3 d": a delay after joining. */
  function daysWord(x) {
    if (x == null || !isFinite(x)) return null;
    var h = x * 24;
    return h < 1 ? Math.max(1, Math.round(h * 60)) + ' min' : x < 1 ? Math.round(h) + ' h' : (x < 10 ? (Math.round(x * 10) / 10) : Math.round(x)) + ' d';
  }
  var FIRST = [['mined', 'Mined', 'days_to_mine'], ['refined', 'Refined', 'days_to_refine'], ['raided', 'Raided', 'days_to_raid'], ['activated', 'Activated', 'days_to_activate']];
  /* The first real moves of who joined in the window: how many, and how long after joining. */
  function firstDefs(ctx) {
    return FIRST.map(function (m) {
      return { key: 'first_' + m[0], stage: 'Activation', label: m[1], cls: m[0] === 'activated' ? 'ok' : null, count: true, def: DEFS[m[1]], get: function (s) {
        var c = cohortWin(s, ctx.win) || {}, t = daysWord(c[m[2]]);
        return { value: int(c[m[0]]), raw: c[m[0]], sub: [shareOf(c[m[0]], c.joined, 'joined'), t ? 'typically ' + t + ' after joining' : null].filter(Boolean).join(' · ') || null };
      } };
    });
  }
  function firstTable(seg) {
    var t = grid('ob-first', [{ label: 'Week of', k: 't', w: 'minmax(9ch, .8fr)', def: 'Joined in the week starting (Monday UTC).' }, { label: 'Joined', k: 'n' }, { label: 'Acted', k: 'n', opt: true }]
      .concat(FIRST.map(function (m) { return { label: m[1], k: 'n', def: DEFS[m[1]] }; })));
    ((seg.pirate_cohorts || {}).weeks || []).slice().reverse().forEach(function (wk) {
      addRow(t, [cell((wk.exact ? '' : '≈ ') + shortDay(wk.week), 'ob-step', wk.exact ? null : DEFS['Join date']), cell(int(wk.joined), 'ob-v'), stack(int(wk.acted), wk.joined >= SMALL_N ? pct(wk.acted / wk.joined) : null)]
        .concat(FIRST.map(function (m) { var t0 = daysWord(wk[m[2]]); return stack(int(wk[m[0]]), t0 ? 'after ' + t0 : null); })), { data: { week: wk.week }, cls: wk.joined ? '' : 'is-empty' });
    });
    return t;
  }
  function viewFirstMoves(ctx) {
    var d = ctx.d, segs = ctx.segs, box = H.el('div', 'ob-view');
    if (!segs.length || !segs[0].pirate_cohorts) { box.appendChild(emptyOr(d, 'No players read yet')); return box; }
    var strip = H.navStrip(PIRATE_WINDOWS, ctx.win, function (k) { ctx.set({ win: k }); });
    strip.classList.add('ob-windows');
    var scope = H.el('span', 'ob-scope-line');
    scope.appendChild(strip);
    scope.appendChild(chip(groupScope(segs[0], ctx.win, 'players'), DEFS.Joined));
    box.appendChild(kpi(ctx, firstDefs(ctx), scope, ctx.win === 'all' ? 'all time' : WIN_WORD[ctx.win]));
    segs.forEach(function (s) {
      var b = block(segs.length > 1 ? 'First moves by join week · ' + segName(s) : 'First moves by join week', { key: 'first', scope: 'Join weeks · so far · median delay', def: DEFS.Cohort });
      b.appendChild(firstTable(s));
      box.appendChild(b);
    });
    return box;
  }
  var LEARN = { steps: viewLearnSteps, first: viewFirstMoves, after: viewImpact, runs: viewRuns };
  function viewOnboarding(ctx) {
    var d = ctx.d, box = H.el('div', 'ob-view');
    box.appendChild(viewStrip(ctx));
    var t = tutorialOf(ctx.segs[0]);
    if (ctx.view === 'steps' && !t.offered && ctx.segs.length === 1) { box.appendChild(emptyOr(d, 'No tutorial sessions yet')); return box; }
    if (ctx.view === 'steps' || ctx.view === 'after') box.appendChild(kpi(ctx, onboardingKpi(ctx), H.el('span', 'ob-chip', ctx.view === 'after' ? 'Since telemetry began' : 'All time'), 'all time'));
    box.appendChild(LEARN[ctx.view](ctx));
    return box;
  }

  // ── STAY: who comes back, and how often ──
  var TRI_WEEKS = 8;
  /* Week N after joining began before the activity feed reaches back (it keeps
   * 30 days a read): for it, played counts only mines, refines and raids. */
  function beforeFeed(seg, week, n) {
    var since = ((seg && seg.pirate_cohorts) || {}).played_since;
    if (!since) return true;
    return Date.parse(week + 'T00:00:00Z') + 7 * (n - 1) * 86400000 < Date.parse(since + 'T00:00:00Z');
  }
  function feedNote(seg) {
    var since = ((seg && seg.pirate_cohorts) || {}).played_since;
    return since ? 'Before ' + shortDay(since) + ' only mines, refines and raids count as played: the activity feed reaches no further back.' : 'The activity feed is not read yet: only mines, refines and raids count as played.';
  }
  /* Played in week N after joining, of every joiner that week; a week not lived yet is blank. */
  function triangle(seg) {
    var t = H.el('div', 'ob-cohorts ob-triangle');
    var head = H.el('div', 'ob-cohort ob-cohort-head');
    ['Week of', 'Joined', 'Acted'].concat(Array.from({ length: TRI_WEEKS }, function (_, i) { return 'Wk ' + (i + 1); })).forEach(function (c) { head.appendChild(H.el('span', null, c)); });
    t.appendChild(head);
    ((seg.pirate_cohorts || {}).weeks || []).forEach(function (wk) {
      var row = H.el('div', 'ob-cohort' + (wk.joined ? '' : ' is-empty'));
      row.setAttribute('data-week', wk.week);
      var name = H.el('span', null, (wk.exact ? '' : '≈ ') + shortDay(wk.week));
      if (!wk.exact) name.title = DEFS['Join date'];
      row.appendChild(name);
      row.appendChild(H.el('span', 'ob-v ob-n', int(wk.joined)));
      row.appendChild(wk.joined ? heatCell(wk.acted, wk.joined) : H.el('span', 'ob-heat ob-heat-none'));
      for (var i = 1; i <= TRI_WEEKS; i++) {
        var v = wk['retained_w' + i], hc = wk.joined && v != null ? heatCell(v, wk.joined) : H.el('span', 'ob-heat ob-heat-none');
        if (v != null && beforeFeed(seg, wk.week, i)) { hc.classList.add('is-partial'); hc.title = (hc.title ? hc.title + ' · ' : '') + feedNote(seg); }
        row.appendChild(hc);
      }
      t.appendChild(row);
    });
    return t;
  }
  function activeUsersBlock(ctx) {
    var a0 = ctx.segs[0].active_users, tags = guildTags(ctx.d);
    if (!a0) return null;
    /* The page's window, like the tile above: the list holds 30 days. */
    var days = Number(ctx.win) || 30, now = ctx.d.generated_ms || Date.now();
    var within = a0.within && a0.within[String(days)];
    var au = within == null ? a0 : { total: within, players: a0.players.filter(function (x) { return x.last_ms > now - days * 864e5; }) };
    var b = block('Active users · ' + int(au.total), { key: 'active_users', scope: 'Activated · seen in the last ' + WIN_WORD[ctx.win], def: DEFS['Active users'],
      extra: au.players.length ? [actionBtn('Copy ids', function () { copyText(au.players.map(function (x) { return x.player_id; }).join('\n'), au.players.length); }, 'copy_ids')] : [] });
    if (!au.players.length) { b.appendChild(H.stateBlock('empty', 'No active users')); return b; }
    var t = grid('ob-active-users', [{ label: 'Player', k: 't', w: 'minmax(15ch, 1.3fr)' }, { label: 'Guild', k: 't', opt: true }, { label: 'Days played', k: 'n', def: 'Days with a gameplay action in the last 30.' },
      { label: 'Raids', k: 'n', opt: true }, { label: 'Joined', k: 'n', opt: true }, { label: 'Seen', k: 'n' }]);
    au.players.forEach(function (x) {
      addRow(t, [playerLink(x), cell(tags[x.guild_id] || x.guild_id), cell(int(x.played_30), 'ob-v'), int(x.raids), cell(x.joined_ms ? H.ago(x.joined_ms) : '—', 'ob-sub'), cell(x.last_ms ? H.ago(x.last_ms) : '—', 'ob-sub')], { data: { player: x.player_id } });
    });
    if (au.total > au.players.length) b.appendChild(sub(int(au.players.length) + ' listed of ' + int(au.total)));
    b.appendChild(t);
    return b;
  }
  function stayDefs(ctx) {
    return [K.activeUsers(ctx), K.active(ctx), K.stickiness(ctx),
      { key: 'played', stage: 'Retention', label: 'Played', scope: 'last 30 days', def: DEFS.Played, get: function (s) { var p = s.played || {}; return { value: int(p.players), raw: p.players, sub: shareOf(p.players, s.players, 'players') }; } }];
  }
  function viewStay(ctx) {
    var d = ctx.d, segs = ctx.segs, box = H.el('div', 'ob-view');
    if (!segs.length || !segs[0].pirate_cohorts) { box.appendChild(emptyOr(d, 'No players read yet')); return box; }
    box.appendChild(kpi(ctx, stayDefs(ctx), windowStrip(ctx), WIN_WORD[ctx.win]));
    segs.forEach(function (s, i) {
      var b = block(segs.length > 1 ? 'Played, by weeks since joining · ' + segName(s) : 'Played, by weeks since joining', { key: 'triangle', scope: 'Join weeks · every joiner', def: DEFS.Cohort });
      b.appendChild(triangle(s));
      box.appendChild(b);
    });
    var two = H.el('div', 'ob-two');
    var cap = captivatedBlock(ctx, 'Days played');
    if (cap) two.appendChild(cap);
    if (segs.length === 1) { var au = activeUsersBlock(ctx); if (au) two.appendChild(au); }
    if (two.firstChild) box.appendChild(two);
    var tb = trendsBlock(ctx, ['Retention']);
    if (tb) box.appendChild(tb);
    return box;
  }

  /* Below SMALL_N a cell is a count, drawn quieter: a percentage claims more than it can carry. */
  function heatCell(n, total) {
    if (n == null) return H.el('span', 'ob-heat ob-heat-none');
    /* One unit in every cell: players. A cohort big enough for a share is
     * tinted by it, and every cell says "k of n" (and the share) on hover. */
    var rate = ratio(n, total), small = total < SMALL_N;
    var c = H.el('span', 'ob-heat ' + (small ? 'ob-heat-count' : 'ob-heat-' + heatBand(rate)), int(n));
    c.title = int(n) + ' of ' + int(total) + (small ? '' : ' · ' + pct(rate));
    return c;
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
  // ── LEAVING: how far they got, where they stuck, who stays, who is lost ──
  /* The players behind a leaving row, newest seen first. */
  function leftList(ctx, rows, total) {
    var tags = guildTags(ctx.d), box = H.el('div', 'ob-who');
    var head = H.el('div', 'ob-who-head');
    head.appendChild(sub(total > rows.length ? int(rows.length) + ' listed of ' + int(total) : plural(rows.length, 'player', 'players')));
    head.appendChild(actionBtn('Copy ids', function () { copyText(rows.map(function (x) { return x.player_id; }).join('\n'), rows.length); }, 'copy_ids'));
    box.appendChild(head);
    rows.forEach(function (x) {
      var r = H.el('div', 'ob-who-row');
      r.setAttribute('data-player', x.player_id);
      r.appendChild(playerLink(x));
      r.appendChild(cell(tags[x.guild_id] || x.guild_id, 'ob-n'));
      r.appendChild(cell(x.joined_ms ? 'joined ' + H.ago(x.joined_ms) : '—', 'ob-n ob-sub'));
      r.appendChild(cell(x.last_ms ? 'seen ' + H.ago(x.last_ms) : 'never acted', 'ob-n ob-sub'));
      box.appendChild(r);
    });
    return box;
  }
  /* Where every player is now, by when they last did anything on chain. */
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
  function leftBuckets(l) { return LEFT_ORDER.filter(function (k) { return k !== 'not_read' || (l.furthest || {})[k] > 0; }); }
  function furthestBlock(ctx) {
    var segs = ctx.segs, l0 = segs[0].left;
    var b = block('How far they got before they left', { key: 'furthest', scope: 'Gone ' + l0.days + ' days · ' + int(l0.left) + ' of ' + int(l0.players) + ' players', def: DEFS['Furthest reached'] });
    if (segs.length > 1) {
      var t2 = grid('ob-compare', [{ label: 'Furthest reached', k: 't', w: 'minmax(22ch, 1.6fr)' }].concat(segs.map(function (s, i) { return { label: segLabel(s, i), k: 'n' }; })));
      leftBuckets(l0).forEach(function (k) {
        addRow(t2, [cell(LEFT_LABEL[k], 'ob-step')].concat(segs.map(function (s) { var l = s.left || {}; var n = (l.furthest || {})[k]; return stack(int(n), ofShare(n, l.left)); })), { data: { bucket: k } });
      });
      b.appendChild(t2);
      return b;
    }
    var top = leftBuckets(l0).reduce(function (m, k) { return Math.max(m, l0.furthest[k] || 0); }, 0);
    var t = grid('ob-furthest', [{ label: 'Furthest reached', k: 't', w: 'minmax(22ch, 1.4fr)' }, { label: 'Players', k: 'n' }, { label: 'Share', k: 'n', def: 'Of the players who left.' }, { label: '', k: 'b', opt: true }]);
    leftBuckets(l0).forEach(function (k) {
      var n = l0.furthest[k] || 0, who = (l0.who || {})[k] || [];
      var r = addRow(t, [cell(LEFT_LABEL[k], 'ob-step', DEFS[LEFT_LABEL[k]]), cell(int(n), 'ob-v'), cell(share(n, l0.left)), bar(ratio(n, top), k === 'activated' ? 'ok' : '')], { data: { bucket: k } });
      if (n > 0) drill(t, r, 'left:' + k, function () { return leftList(ctx, who, n); });
    });
    b.appendChild(t);
    return b;
  }
  /* Where recorded signups stopped, then what the tutorial's finishers did next. */
  function stuckBlock(ctx) {
    var seg = ctx.segs[0], cov = seg.coverage;
    /* One group throughout: the sample of recorded signups. Finishing is
     * reaching the End phase, of the same players who signed up. */
    var all = phaseRows(seg), rows = all.filter(function (r) { return r.stopped > 0; });
    var end = all.filter(function (r) { return r.label === 'End'; })[0];
    if (!rows.length && !end) return null;
    var b = block('Stuck', { key: 'stuck', scope: 'Recorded signups' + (cov ? ' · since ' + shortDay(cov.since) : ''), extra: [actionBtn('Phases', function () { ctx.go('onboarding', 'steps'); }, 'to_phases')] });
    var t = grid('ob-stuck', [{ label: 'Last step they recorded', k: 't', w: 'minmax(22ch, 1.4fr)' }, { label: 'Players', k: 'n' }, { label: 'Of reached', k: 'n', def: DEFS['Stop rate'] }]);
    rows.forEach(function (r) {
      addRow(t, [cell(r.phase === 0 ? 'Finished signup, nothing after' : 'Left in ' + r.label, 'ob-step'), cell(int(r.stopped), 'ob-v'), cell(share(r.stopped, r.reached))], { data: { phase: r.phase } });
    });
    if (end) addRow(t, [cell('Finished Combat Training', 'ob-step', 'Reached the End phase, of the ' + int(all[0].reached) + ' who signed up'), cell(int(end.reached), 'ob-v'), cell(shareOf(end.reached, all[0].reached, 'signed up'))], { data: { phase: 'finished' }, cls: 'is-stage' });
    b.appendChild(t);
    var imp = (ctx.d.tutorial_impact || []).filter(function (r) { return r.key === 'finished'; })[0];
    if (imp && imp.players) {
      var t2 = grid('ob-after', [{ label: 'The finishers, afterwards on chain', k: 't', w: 'minmax(22ch, 1.4fr)' }, { label: 'Players', k: 'n' }, { label: 'Of finishers', k: 'n' }]);
      [['acted', 'Acted'], ['mined', 'Mined'], ['refined', 'Refined'], ['raided', 'Initiated a raid'], ['activated', 'Activated']].forEach(function (m) {
        addRow(t2, [cell(m[1], 'ob-step'), cell(int(imp[m[0]]), 'ob-v'), cell(share(imp[m[0]], imp.players))], { data: { after: m[0] } });
      });
      var sc = H.el('div', 'ob-block-sub');
      sc.appendChild(chip('Every guild · ' + plural(imp.players, 'finisher', 'finishers'), 'Tutorial finishers since telemetry began; this table does not follow the filters.'));
      b.appendChild(sc);
      b.appendChild(t2);
    }
    return b;
  }
  var PLAYED_BUCKETS = [[1, 1, '1 day'], [2, 2, '2 days'], [3, 3, '3 days'], [4, 7, '4–7 days'], [8, 14, '8–14 days'], [15, 30, '15–30 days']];
  /* Days played in the last 30, of those who played at all. */
  function playedRows(p) {
    var days = (p && p.days) || [];
    return PLAYED_BUCKETS.map(function (bk) {
      var n = 0;
      for (var i = bk[0]; i <= bk[1]; i++) n += days[i - 1] || 0;
      return { key: bk[0] + '-' + bk[1], label: bk[2], n: n };
    });
  }
  function captivatedBlock(ctx, title) {
    var p = ctx.segs[0].played;
    if (!p) return null;
    var extra = p.activity_unread ? [chip(int(p.activity_unread) + ' activity not read', 'Acted, but the activity feed is not read yet: only their mines, refines and raids count as played.')] : [];
    var b = block(title || 'Days played', { key: 'captivated', scope: 'Days played, last ' + p.window + ' · ' + plural(p.players, 'player', 'players'), def: DEFS.Played, extra: extra });
    var rows = playedRows(p), top = rows.reduce(function (m, r) { return Math.max(m, r.n); }, 0);
    var t = grid('ob-played', [{ label: 'Played on', k: 't', w: 'minmax(12ch, .8fr)' }, { label: 'Players', k: 'n' }, { label: 'Share', k: 'n' }, { label: '', k: 'b' }]);
    rows.forEach(function (r) { addRow(t, [cell(r.label, 'ob-step'), cell(int(r.n), 'ob-v'), cell(share(r.n, p.players)), bar(ratio(r.n, top))], { data: { played: r.key } }); });
    b.appendChild(t);
    return b;
  }
  /* What could show confusion, with what is recorded today and what is not. */
  function confusedRows(seg) {
    var dw = seg.dwell || {}, l = seg.left || {};
    var slow = Object.keys(dw).filter(function (k) { var x = dw[k]; return x && x.n >= SMALL_N && x.p50 > 0 && x.p90 >= 4 * x.p50; });
    return [
      { key: 'slow', label: 'Slow steps', value: slow.length, sub: 'p90 at least 4× the median', page: ['onboarding', 'steps'] },
      { key: 'replays', label: 'Replayed Combat Training', value: seg.runs ? seg.runs.replays : null, sub: 'runs started from Help', page: ['onboarding', 'runs'] },
      { key: 'acted_only', label: 'Acted, then left before mining', value: l.furthest ? l.furthest.acted_only : null, sub: 'players' },
      { key: 'failed_tx', label: 'Failed or refused transactions', value: null, unrecorded: true },
      { key: 'help', label: 'Help, FAQ or Comms opened early', value: null, unrecorded: true },
    ];
  }
  function confusedBlock(ctx) {
    var b = block('Confused', { key: 'confused', scope: 'Signs, and whether they are recorded' });
    var t = grid('ob-confused', [{ label: 'Sign', k: 't', w: 'minmax(24ch, 1.6fr)' }, { label: '', k: 'n' }, { label: '', k: 't', opt: true }]);
    confusedRows(ctx.segs[0]).forEach(function (r) {
      var name = r.page ? link(r.label, function () { ctx.go(r.page[0], r.page[1]); }, 'ob-step') : cell(r.label, 'ob-step');
      addRow(t, [name, r.unrecorded ? cell('not recorded', 'ob-sub ob-notyet') : cell(int(r.value), 'ob-v'), cell(r.unrecorded ? '' : r.sub, 'ob-sub')], { data: { sign: r.key }, cls: r.unrecorded ? 'is-empty' : '' });
    });
    b.appendChild(t);
    return b;
  }
  function viewLeaving(ctx) {
    var d = ctx.d, segs = ctx.segs, box = H.el('div', 'ob-view');
    if (!segs.length || !segs[0].left) { box.appendChild(emptyOr(d, 'No players read yet')); return box; }
    box.appendChild(furthestBlock(ctx));
    box.appendChild(lifecycleBlock(segs));
    if (segs.length === 1) {
      var two = H.el('div', 'ob-two');
      [stuckBlock(ctx), captivatedBlock(ctx)].forEach(function (n) { if (n) two.appendChild(n); });
      if (two.firstChild) box.appendChild(two);
      box.appendChild(confusedBlock(ctx));
    }
    box.appendChild(playerList(ctx, 'stopped'));
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
  function searchBox(ctx, kind) {
    var qk = 'q_' + (kind || '');
    var lab = H.el('label', 'sui-input-text ob-search');
    var inp = H.el('input');
    inp.type = 'text';
    inp.placeholder = 'Name, id or guild';
    inp.value = ctx.st[qk] || '';
    lab.setAttribute('data-list', kind || '');
    inp.addEventListener('input', function () {
      ctx.st[qk] = inp.value;
      clearTimeout(ctx.st.qt);
      ctx.st.qt = setTimeout(function () { ctx.redraw(); var n = ctx.host.querySelector('.ob-search[data-list="' + (kind || '') + '"] input'); if (n) { n.focus(); n.setSelectionRange(n.value.length, n.value.length); } }, 150);
    });
    lab.appendChild(inp);
    return lab;
  }
  function pills(ctx, rows, key, kinds, labelOf, valueOf) {
    var seen = kinds.filter(function (k) { return rows.some(function (x) { return valueOf(x) === k; }); });
    /* `null` is All: a kind can be 0 (the first phase), which reads as false. */
    var show = seen.indexOf(ctx.st[key]) >= 0 ? ctx.st[key] : null;
    var box = H.el('div', 'ob-pills');
    [null].concat(seen).forEach(function (k) {
      var n = k != null ? rows.filter(function (x) { return valueOf(x) === k; }).length : rows.length;
      var a = H.el('a', 'ob-pill' + (k === show ? ' is-on' : ''), (k != null ? labelOf(k) : 'All') + ' ' + int(n));
      a.href = 'javascript:void(0)';
      a.setAttribute('data-outcome', k != null ? k : 'all');
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
  /* The named players behind the card, one list wherever it is drawn: the
   * newest signups (Join), everyone named as stopping (Leaving), the newest
   * tutorial runs (Learn ▸ Runs). A search, outcome or phase pills, a sort. */
  var LIST_TITLE = { signups: 'Newest signups', stopped: 'Stopped, by name', runs: 'Newest runs' };
  function playerList(ctx, kind) {
    var d = ctx.d, tags = guildTags(d);
    var all = kind === 'runs' ? d.runs || [] : kind === 'stopped' ? stoppedRows(d) : d.recent || [];
    var stoppedTotal = Object.keys(d.stopped || {}).reduce(function (a, k) { return a + (d.stopped[k].total || 0); }, 0);
    var scope = kind === 'stopped' ? 'As named by the servers' + (stoppedTotal > all.length ? ' · ' + int(all.length) + ' of ' + int(stoppedTotal) : '') : kind === 'runs' ? 'Newest read' : 'Newest sampled';
    var b = block(LIST_TITLE[kind], { key: 'list_' + kind, scope: scope + (ctx.segs.length > 1 ? ' · not split' : '') });
    if (!all.length) { b.appendChild(H.stateBlock('empty', kind === 'runs' ? 'No tutorial runs yet' : kind === 'stopped' ? 'No one named as stopped yet' : 'No sessions sampled yet')); return b; }
    var pk = 'pill_' + kind, p;
    if (kind === 'stopped') p = pills(ctx, all, pk, PHASES.map(function (x, i) { return i; }), function (k) { return PHASES[k][1]; }, function (x) { return x.phase; });
    else p = pills(ctx, all, pk, ['completed', 'declined', 'left', 'deciding', 'playing'], function (k) { return OUTCOME_LABEL[k]; }, function (x) { return x.outcome; });
    if (kind === 'stopped' && ctx.st.stepFilter && !all.some(function (x) { return x.step === ctx.st.stepFilter; })) ctx.st.stepFilter = null;
    var q = ctx.st['q_' + kind];
    var rows = all.filter(function (x) { return (p.show == null || (kind === 'stopped' ? x.phase === p.show : x.outcome === p.show)) && (kind !== 'stopped' || !ctx.st.stepFilter || x.step === ctx.st.stepFilter) && matches(x, q, tags); });
    b.querySelector('.ob-title').textContent = LIST_TITLE[kind] + ' · ' + int(rows.length) + (rows.length !== all.length ? ' of ' + int(all.length) : '');
    b.querySelector('.ob-actions').insertBefore(actionBtn('Copy ids', function () { copyText(rows.map(function (x) { return x.player_id; }).filter(Boolean).join('\n'), rows.length); }, 'copy_ids'), b.querySelector('.ob-actions').lastChild);
    var bar1 = H.el('div', 'ob-find');
    bar1.appendChild(searchBox(ctx, kind));
    bar1.appendChild(p.node);
    if (kind === 'stopped' && ctx.st.stepFilter) bar1.appendChild(link(stepLabel(ctx.st.stepFilter) + ' ×', function () { ctx.st.stepFilter = null; ctx.redraw(); }, 'ob-pill is-on'));
    b.appendChild(bar1);
    if (kind === 'runs') b.appendChild(runTable(d, rows, ctx.st, ctx.redraw));
    else if (kind === 'stopped') {
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
    return b;
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
  function dataGuilds(ctx) {
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
      { label: 'Signups', k: 'n', w: 'minmax(14ch, .8fr)', opt: true, sort: 'signups', def: 'Finished signups as a share of signup starts, from the guild\'s own server.' },
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
        var stuck = link('Stopped', function () { ctx.set({ guild: g.id, page: 'leaving', view: '' }); }, 'ob-focus');
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
  function dataRecord(ctx) {
    var d = ctx.d, box = H.el('div', 'ob-view');
    var hist = d.history || [], last = hist[hist.length - 1] || {};
    function lvl(k, label, cls) {
      return { key: k, label: label, cls: cls, get: function () {
        var p = trendPoints(d, trendDef(k));
        var c = trendChange(p, 7, 'level');
        return { value: int(p.length ? p[p.length - 1][1] : null), delta: c == null ? null : { change: c, then: p[p.length - 1][1] - c, now: p[p.length - 1][1] }, spark: p.slice(-30).map(function (x) { return x[1]; }) };
      } };
    }
    box.appendChild(kpi(Object.assign({}, ctx, { segs: [{}], win: '7' }), [lvl('humans', 'Players'), lvl('active_7d', 'Active this week', 'ok'),
      { key: 'new', label: 'Joined', get: function () { var p = trendPoints(d, trendDef('new')); return { value: int(trendChange(p, 30, 'daily')), sub: 'in the last 30 days', spark: p.slice(-30).map(function (x) { return x[1]; }) }; } },
      { key: 'record', label: 'Daily record', get: function () { return { value: hist.length ? int(hist.length) : '—', sub: hist.length ? 'days since ' + shortDay(hist[0].day) : 'nothing recorded yet' }; } },
    ], H.el('span', 'ob-chip', last.day ? 'Through ' + shortDay(last.day) : 'No record yet'), last.day ? 'through ' + shortDay(last.day) : ''));
    var rows = TRENDS.map(function (m) { return [m, trendPoints(d, m)]; }).filter(function (r) { return r[1].length; });
    if (!rows.length) { box.appendChild(emptyOr(d, 'No days recorded yet')); box.appendChild(viewDaily(ctx)); return box; }
    /* A break: rows counted by an older definition are kept, not drawn. */
    var older = hist.length - currentRows(hist).length;
    var picked = ctx.st.picked = (ctx.st.picked || []).filter(function (k) { return rows.some(function (r) { return r[0][0] === k; }); });
    var go = actionBtn(picked.length ? 'Chart ' + picked.length : 'Chart', function () { openChart(picked.length ? picked : ['humans', 'active_7d']); }, 'chart_picked');
    go.title = 'Tick up to six figures to chart them together';
    var extra = older ? [chip(plural(older, 'earlier day', 'earlier days') + ' under an older definition, not drawn', 'A definition changed: the line starts again where it did.'), go] : [go];
    var b = block('Figures', { key: 'figures', noTag: true, scope: 'Humans, ' + (OB.tag || 'every guild') + ((ctx.d.filters || {}).compare ? ' · not split' : ''), def: DEFS['Daily record'], extra: extra });
    b.appendChild(trendTable(ctx, rows, true));
    box.appendChild(b);
    box.appendChild(viewDaily(ctx));
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
  function dataHealth(ctx) {
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
    var cov = (ctx.segs[0] || {}).coverage;
    if (cov && cov.joined) {
      var tags = guildTags(d);
      var cb = block('Coverage · ' + int(cov.tracked) + ' of ' + int(cov.joined), { key: 'coverage', scope: 'Joined since ' + shortDay(cov.since), def: DEFS.Coverage });
      var ct = grid('ob-cov', [{ label: 'Guild', k: 't' }, { label: 'Joined', k: 'n' }, { label: 'Signup recorded', k: 'n', def: DEFS['Signup recorded'] }, { label: 'Share', k: 'n' }, { label: '', k: 'b', opt: true }]);
      (cov.guilds || []).slice().sort(function (a, b) { return b.joined - a.joined; }).forEach(function (g) {
        addRow(ct, [cell(tags[g.guild] || g.guild, 'ob-step', g.guild), cell(int(g.joined), 'ob-v'), cell(int(g.tracked)), cell(share(g.tracked, g.joined)), bar(ratio(g.tracked, g.joined), g.tracked ? '' : 'bad')],
          { data: { guild: g.guild }, cls: g.tracked ? '' : 'is-bad' });
      });
      cb.appendChild(ct);
      box.appendChild(cb);
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
    var reps = H.checkbox(!!(d.filters || {}).replicants, 'Include replicants', function (v) { ctx.set({ reps: v ? '1' : '' }); });
    reps.classList.add('ob-reps-switch');
    reps.setAttribute('data-control', 'reps');
    form.appendChild(reps);
    var ex = H.checkbox(!!(d.filters || {}).include_excluded, 'Include excluded players', function (v) { ctx.set({ excl: v ? '1' : '' }); });
    ex.classList.add('ob-ex-switch');
    ex.setAttribute('data-control', 'excl');
    form.appendChild(ex);
    set.appendChild(form);
    box.appendChild(set);
    box.appendChild(testsBlock(ctx));
    var rc = reconcileBlock(ctx);
    if (rc) box.appendChild(rc);
    box.appendChild(footLine(d));
    return box;
  }
  /* Who the test-account name rule caught: a wrong catch shows here. */
  function testsBlock(ctx) {
    var t = (ctx.d.crawl || {}).tests || {}, rows = t.players || [], tags = guildTags(ctx.d);
    var b = block('Test accounts · ' + int(rows.length), { key: 'tests', scope: t.left_out === false ? 'Included' : 'Left out of every figure', copy: false });
    if (!rows.length) { b.appendChild(H.stateBlock('empty', 'No test accounts')); return b; }
    var g = grid('ob-tests', [{ label: 'Player', k: 't', w: 'minmax(15ch, 1.4fr)' }, { label: 'Guild', k: 't', w: 'minmax(6ch, .5fr)' }]);
    rows.forEach(function (x) { addRow(g, [playerLink({ player_id: x.id, name: x.name }), cell(tags[x.guild] || x.guild || '—')], { data: { player: x.id } }); });
    b.appendChild(g);
    return b;
  }
  function dataDistributions(ctx) {
    var box = H.el('div', 'ob-view');
    STATS.forEach(function (st) { box.appendChild(distBlock(st[1], ctx.segs, function (s) { return s.stats && s.stats[st[0]]; }, st[2])); });
    box.appendChild(distBlock('Play length of inactive players after signup', ctx.segs, function (s) { return s.play_length; }, 'secs'));
    return box;
  }
  /* Every word on the card, once: the captions read from this. */
  function dataDictionary(ctx) {
    var box = H.el('div', 'ob-view');
    var gl = block('Definitions', { key: 'definitions', noTag: true });
    var dt = grid('ob-defs', [{ label: 'Term', k: 't', w: 'minmax(16ch, .6fr)' }, { label: 'Means', k: 't', w: 'minmax(20ch, 2fr)' }]);
    Object.keys(DEFS).forEach(function (k) { addRow(dt, [cell(k, 'ob-step ob-v'), cell(DEFS[k], 'ob-wrap')], { data: { term: k } }); });
    gl.appendChild(dt);
    box.appendChild(gl);
    box.appendChild(footLine(ctx.d));
    return box;
  }
  var DATA = { health: dataHealth, guilds: dataGuilds, record: dataRecord, distributions: dataDistributions, dictionary: dataDictionary };
  function viewData(ctx) {
    var box = H.el('div', 'ob-view');
    box.appendChild(viewStrip(ctx));
    box.appendChild(DATA[ctx.view](ctx));
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
      ['Joined, 7 days', winOf(seg, 7).new, tail(ps.new, 7)],
      ['Joined, 30 days', winOf(seg, 30).new, tail(ps.new, 30)],
      ['Newly activated, 30 days', winOf(seg, 30).activated, tail(ps.activations, 30)],
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
  var CRAWLED = { overview: 1, onboarding: 1, engagement: 1, leaving: 1 };

  // ── The frame: sections, scope bar, status ──
  function viewStrip(ctx) {
    var list = VIEWS[ctx.page];
    var s = H.navStrip(list.map(function (v) { return { key: v[0], label: v[1] }; }), ctx.view, function (k) { ctx.go(ctx.page, k); });
    s.classList.add('ob-subnav');
    return s;
  }
  var DEFAULTS = { iface: '', guild: '', compare: '', version: '' };
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
    var guilds = [{ value: '', label: 'Every guild' }].concat((o.guilds || []).map(function (g) { return { value: g.id, label: g.label + ' · ' + g.id }; }));
    put('guild', H.selectBox(f.guild || '', guilds, function (v) { set({ guild: v }); }), !!f.guild);
    var ifaces = [{ value: '', label: 'Any app' }].concat((o.interfaces || []).map(function (i) { return { value: i, label: ifaceName(i) }; }));
    put('iface', H.selectBox(f.interface || '', ifaces, function (v) { set({ iface: v }); }), !!f.interface);
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
    if ((d.filters || {}).replicants) notes.push('replicants in');
    if (notes.length) a.appendChild(H.el('span', 'ob-ex-off', notes.join(' · ')));
    if (c.running) a.appendChild(H.el('i', H.iconClass('icon-in-progress', 'sui-icon-sm')));
    a.appendChild(sub(c.finished_ms ? (c.running ? 'Reading · read ' : 'Read ') + H.ago(c.finished_ms) + ' ago' : c.running ? 'First read' : 'Not read yet'));
    a.title = 'Data health and settings';
    return a;
  }

  // ── The card ──
  var DRAW = { overview: viewOverview, acquisition: viewAcquisition, onboarding: viewOnboarding, engagement: viewStay, leaving: viewLeaving, data: viewData };
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
      function go(page, view) { var to = unfold(page, view || ''); set({ page: to[0] === 'overview' ? '' : to[0], view: to[1] || '' }); }
      function draw(d) {
        st.last = d;
        host.innerHTML = '';
        var page = pageOf(p);
        OB.tag = p.guild ? (guildTags(d)[p.guild] || p.guild) : null;
        /* All time is the Pirate page's own window; elsewhere it reads as 30 days. */
        var win = { 1: '1', 7: '7', 30: '30', all: 'all' }[p.win] || '30';
        if (win === 'all' && page !== 'overview' && !(page === 'onboarding' && viewOf(p) === 'first')) win = '30';
        var c = { d: d, segs: d.segments || [], page: page, view: viewOf(p), win: win, st: st, set: set, go: go, host: host,
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
        /* Learn ▸ Runs comes from the servers, not the crawl: it draws while the crawl runs. */
        if (CRAWLED[page] && !(page === 'onboarding' && c.view === 'runs') && reading(d) && !hasData(d)) main.appendChild(H.stateBlock('loading', progress(d)));
        else main.appendChild(DRAW[page](c));
        wrap.appendChild(main);
        host.appendChild(wrap);
        // The crawl fills in between reads: look again sooner than the cadence while it runs.
        clearTimeout(st.soon);
        if (reading(d)) st.soon = setTimeout(function () { st.stale = true; T.refresh(ctx.id); }, 5000);
      }
      /* 1–6 open the sections, [ and ] step through a section's views. */
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
    fmtKind: fmtKind, argsOf: argsOf, pirateRows: pirateRows, playedRows: playedRows, confusedRows: confusedRows, parseArgs: parseArgs, wordOf: wordOf, deltaOf: deltaOf, increments: increments,
    pageOf: pageOf, viewOf: viewOf, runWeeks: runWeeks, deltaFor: deltaFor, shareOf: shareOf, reconcileRows: reconcileRows, tsvOf: tsvOf, orderSteps: orderSteps, weekStart: weekStart, durWords: durWords, sourceRows: sourceRows, worstRates: worstRates };
})();
