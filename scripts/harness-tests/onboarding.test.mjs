// The Telemetry card (board-terminal-onboarding.js) against the static harness.
//
//   bash scripts/make_harness.sh && node scripts/harness-tests/onboarding.test.mjs
//
// The brief this pins (proposals/telemetry-redesign.md, then the 2026-11-20
// cohort review): nine sections in
// journey order drawn with ONE grammar — a scope bar that never changes shape,
// a KPI strip that states its time scope, blocks with the same actions, one
// table component with one drill — over every guild, splittable by one
// dimension, and every old figure still there.
import { JSDOM } from 'jsdom';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const harness = resolve(repo, 'frontend', '_harness.html');
if (!existsSync(harness)) { console.error('missing frontend/_harness.html — run: bash scripts/make_harness.sh'); process.exit(2); }
const read = (p) => readFileSync(resolve(repo, p), 'utf8');

let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? '  ok ' : 'FAIL ') + name + (ok || detail == null ? '' : ' — ' + detail));
  if (!ok) failures++;
}
async function until(fn, ms = 6000) {
  const t0 = Date.now();
  for (;;) { const v = fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await new Promise((r) => setTimeout(r, 50)); }
}
const text = (n) => (n && n.textContent || '').replace(/\s+/g, ' ').trim();
const PAGE = { Pirate: 'overview', Join: 'acquisition', Learn: 'onboarding', Stay: 'engagement' };

const dom = await JSDOM.fromFile(harness, { url: pathToFileURL(harness).href + '?view=terminal', runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true });
const w = dom.window, d = w.document;
await until(() => w.Board && w.Board.Terminal && w.Board.Terminal.add && w.Board.Terminal.onboarding);
const T = w.Board.Terminal;

// ── ⌘K ──
check('TELEMETRY, ONBOARDING, FUNNEL and SIGNUPS open the card', ['TELEMETRY', 'ONBOARDING', 'FUNNEL', 'SIGNUPS'].every((x) => T.parse(x) && T.parse(x).type === 'onboarding'));
const row = T.suggestFor('').find((o) => /\bTELEMETRY\b/.test(String(o.words || '')));
check('filed under Explore as Telemetry', row && row.group === 'Explore' && row.what === 'Telemetry', JSON.stringify(row || null));
const pp = (line) => (T.parse(line) || {}).params;
check('a word opens a section: TELEMETRY retention lands on Stay, activation on Learn ▸ First moves', JSON.stringify(pp('TELEMETRY retention')) === '{"page":"engagement"}' && JSON.stringify(pp('TELEMETRY activation')) === '{"page":"onboarding","view":"first"}' && JSON.stringify(pp('TELEMETRY learn')) === '{"page":"onboarding"}', JSON.stringify(pp('TELEMETRY retention')));
check('…a view after its section, a window and a guild', JSON.stringify(pp('TELEMETRY onboarding runs 7d guild 0-5')) === '{"page":"onboarding","view":"runs","win":"7","guild":"0-5"}', JSON.stringify(pp('TELEMETRY onboarding runs 7d guild 0-5')));
check('…a split and a bare guild id', JSON.stringify(pp('TELEMETRY 0-5 split interface')) === '{"guild":"0-5","compare":"interface"}', JSON.stringify(pp('TELEMETRY 0-5 split interface')));
check('…and a word it does not know is not a command', T.parse('TELEMETRY banana') === null);

// ── Pure pieces ──
const O = T.onboarding;
check('a step belongs to its phase; loading is the offer\'s', O.phaseOf('tutorial.first_attack.combat') === 6 && O.phaseOf('tutorial.loading') === 1 && O.phaseOf('signup.submit') === 0 && O.phaseOf('nothing') === -1);
const ph = O.phaseRows({ sessions: 10, durations: { signup: { p50: 120 } }, dwell: { 'tutorial.intro.welcome': { p50: 30 } }, tutorial: { steps: [{ key: 'orientation.tutorial_offer', reached: 9, skipped: 3 }, { key: 'tutorial.intro.welcome', reached: 5 }, { key: 'tutorial.end.ftl_jump', reached: 4 }] } });
check('phases: signed up leads, a skip is told from a stop, the last phase keeps its own', ph.map((r) => r.label).join() === 'Signed up,Offer,Intro,End' && ph[0].stopped === 1 && ph[1].skipped === 3 && ph[1].stopped === 1 && ph[2].time === 30 && ph[3].left === 4 && ph[3].stopped === 0, JSON.stringify(ph));
check('a cohort shades by share', [0, 0.1, 0.4, 0.8, 0.95].map(O.heatBand).join() === '0,1,2,3,4');
check('a step key reads as words, without its phase', O.stepLabel('tutorial.first_attack.choose_rail_gun') === 'First attack · Choose rail gun' && O.stepLabel('signup.recovery_key_create') === 'Recovery key create');
check('under a count, a small total reads as "of N"', O.ofShare(5, 12) === 'of 12' && O.ofShare(5, 50) === '10%' && O.ofShare(1, 0) === null);
check('a share is a percentage only once there are enough to say so', O.share(402, 1102) === '36%' && O.share(3, 10) === '3 of 10' && O.share(0, 0) === '—');
check('outcomes lead with the servers\' unique players, else the sample', O.tutorialOf({ tutorial_players: { players: 9, completed: 4, left_at_offer: 1, left_during_tutorial: 2 }, tutorial: { offered: 3 } }).left === 3 && O.tutorialOf({ tutorial_players: null, tutorial: { offered: 3 } }).offered === 3 && !O.tutorialOf({ tutorial: {} }).unique);
check('a trend change is by date, and needs a point that far back', O.trendChange([['2026-11-01', 1], ['2026-11-02', 4]], 1, 'level') === 3 && O.trendChange([['2026-11-01', 1]], 7, 'level') === null);
check('…a missing day does not shift the week: the newest point on or before it counts', O.trendChange([['2026-11-01', 1], ['2026-11-05', 2], ['2026-11-09', 9]], 7, 'level') === 8);
check('…but a record that missed the window\'s first days has no change for it', O.trendChange([['2026-10-20', 1], ['2026-11-09', 9]], 7, 'level') === null);
check('…and a daily count sums over the window instead', O.trendChange([['2026-11-01', 1], ['2026-11-05', 2], ['2026-11-09', 3]], 7, 'daily') === 5);
check('a delta compares the last window with the one before it', JSON.stringify(O.deltaOf([1, 1, 1, 2, 2, 2], 3, 'daily')) === '{"now":6,"then":3,"change":3}' && O.deltaOf([1, 2], 3, 'daily') === null && O.deltaOf([5, 6, 9], 1, 'level').change === 3);
check('each section names the controls it reads; no page reads an activity filter or the population; a folded section\'s saved card lands where it went', O.uses('data', 'guild') && !O.uses('data', 'iface') && O.uses('engagement', 'compare') && !['overview', 'acquisition', 'onboarding', 'engagement', 'leaving', 'players', 'guilds', 'trends'].some((x) => O.uses(x, 'activity') || O.uses(x, 'reps')) && O.pageOf({ page: 'trends' }) === 'data' && O.viewOf({ page: 'trends' }) === 'record' && O.pageOf({ page: 'guilds' }) === 'data' && O.viewOf({ page: 'guilds' }) === 'guilds' && O.pageOf({ page: 'players', view: 'runs' }) === 'onboarding' && O.viewOf({ page: 'players', view: 'runs' }) === 'runs' && O.pageOf({ page: 'players', view: 'stopped' }) === 'leaving');
check('a running server total sparks as its daily increase', JSON.stringify(O.sparkOf({ history_series: { series: { signups_started: [null, 5, 7, 7, 10] } } }, {}, 'h:signups_started', true)) === '[2,0,3]');
check('the daily record only sparks for the plain population', O.sparkOf({ history_series: { series: { mau: [1, 2, 3] } } }, {}, 'h:mau', false) === null);
check('percentages: whole above 10%, one decimal below, a dash for nothing', O.pct(0.364) === '36%' && O.pct(0.029) === '2.9%' && O.pct(null) === '—' && O.pct(1) === '100%');
check('the flagged steps are the largest, never a zero or a null', JSON.stringify(O.topKeys([{ key: 'a', d: 3 }, { key: 'b', d: null }, { key: 'c', d: 9 }, { key: 'e', d: 0 }], (r) => r.d, 3)) === '["c","a"]');
check('count buckets read as whole ranges, the last open', O.bucketLabel({ lo: 0, hi: 0 }, 'count') === '0' && O.bucketLabel({ lo: 10, hi: 100 }, 'count') === '10–99' && /^≥ /.test(O.bucketLabel({ lo: 1e5, hi: null }, 'count')));
check('refined alpha arrives in grams and is drawn on the alpha ladder', O.fmtKind('alpha', 2) === w.Board.helpers.fmtAlpha(2e6));
const args = O.argsOf({ iface: 'structs-webapp', activity: 'inactive', compare: 'activity', active: '30', idle: '72', page: 'guilds', win: '7' });
check('the card asks with its filters at fixed definitions: quit = 7 days idle, active = 7 days; no activity filter or split; never its page or window', args.filters.interface === 'structs-webapp' && args.filters.activity === null && args.filters.compare === null && args.activeDays === 7 && args.idleHours === 168 && !('page' in args) && !('win' in args) && O.argsOf({ compare: 'guild' }).filters.compare === 'guild', JSON.stringify(args));
check('an unknown page or view falls back to the first', O.pageOf({ page: 'nope' }) === 'overview' && O.viewOf({ page: 'onboarding', view: 'nope' }) === 'steps' && O.viewOf({ page: 'engagement' }) === null && O.viewOf({ page: 'leaving' }) === null);
// The rules every pirate figure follows (the 2026-11-20 review):
//   1. a share names what it is of; 4. a stage is a subset of the row it names,
//   the row above — except retention, which counts every joiner (owner's rule).
const seg0 = { pirate_server: { all: { started: 40, signed_up: 15 } }, pirate_cohorts: { windows: [{ days: 30, from: '2026-10-22', joined: 49, acted: 23, mined: 7, refined: 6, raided: 9, refined_or_raided: 13, activated: 2, playing: 4 }, { days: 'all', from: '2026-09-24', joined: 150, acted: 101, refined: 19, raided: 30, refined_or_raided: 41, activated: 8, playing: 4 }] } };
const pr = O.pirateRows(seg0, '30'), prk = Object.fromEntries(pr.map((r) => [r.key, r]));
check('PIRATE rows: sessions, then the joiners, in the owner\'s order', pr.map((r) => r.key).join() === 'visited,started,signed,joined,acted,refined_or_raided,activated,playing,referred', pr.map((r) => r.key).join());
check('…rule 4: every row is a subset of the row it names, in its own group (every joiner\'s rows name the joiners)', pr.every((r) => !r.of || (prk[r.of] && (prk[r.of].group === r.group || (r.group === 'every' && r.of === 'joined')) && (r.value == null || prk[r.of].value == null || r.value <= prk[r.of].value))), JSON.stringify(pr.map((r) => [r.key, r.value, r.of])));
check('…the row it names is the row above, but retention and referral count every joiner', pr.every((r, i) => !r.of || r.of === pr[i - 1].key || (r.of === 'joined' && ['Retention', 'Referral'].includes(r.stage))));
check('…two roads side by side: refined and raided are parts of one row, never a step', JSON.stringify(prk.refined_or_raided.parts) === '[["Refined",6],["Raided",9]]' && !pr.some((r) => r.of === 'refined' || r.of === 'raided'));
check('…sessions never feed the players: the first joined row converts from nothing', prk.joined.of === null && prk.started.of === null && prk.signed.of === 'started');
check('…rule 6: what nobody records says so, and a window the servers do not cover is missing, not zero', prk.referred.unrecorded && prk.referred.missing && prk.started.missing && prk.signed.missing);
check('…all time reads the servers\' totals and the all-time joiners', O.pirateRows(seg0, 'all').filter((r) => r.key === 'started')[0].value === 40 && O.pirateRows(seg0, 'all').filter((r) => r.key === 'joined')[0].value === 150 && O.pirateRows({}, '7').every((r) => r.missing));
check('captivated: days played fold into whole buckets, every player once', JSON.stringify(O.playedRows({ days: [3, 2, 1, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 5] }).map((r) => r.n)) === '[3,2,1,2,0,5]');
check('confused: what is not recorded says so instead of a zero', O.confusedRows({ dwell: { a: { n: 30, p50: 10, p90: 50 }, b: { n: 30, p50: 10, p90: 30 }, c: { n: 5, p50: 1, p90: 99 } }, runs: { replays: 6 }, left: { furthest: { acted_only: 9 } } }).map((r) => r.unrecorded ? 'nr' : r.value).join() === '1,6,9,nr,nr');

const NOW = Date.UTC(2026, 10, 20), DAY = 86400000;
const wk = O.runWeeks([{ started_ms: NOW - DAY, outcome: 'completed', player_id: '1-1' }, { started_ms: NOW - 2 * DAY, outcome: 'left', player_id: null }, { started_ms: NOW - 9 * DAY, outcome: 'completed', player_id: '1-2' }], NOW, 3);
check('runs: this week against last week, from the run list', wk && wk[0].runs === 2 && wk[0].completed === 1 && wk[0].no_player === 1 && wk[1].runs === 1, JSON.stringify(wk));
check('…but not when the list does not reach back two weeks and holds fewer runs than there are', O.runWeeks(Array.from({ length: 100 }, (_, i) => ({ started_ms: NOW - i * 3600000, outcome: 'completed' })), NOW, 140) === null && O.runWeeks([{ started_ms: NOW - DAY }], NOW, 40) === null);
check('the copied word reads back as the same view', JSON.stringify(O.parseArgs(O.wordOf({ page: 'onboarding', view: 'runs', win: '7', guild: '0-5', compare: 'version', reps: '1', iface: 'structs-desktop', version: 'tutorial-3' }).replace(/^TELEMETRY /, ''))) === '{"page":"onboarding","view":"runs","win":"7","guild":"0-5","compare":"version","reps":"1","iface":"structs-desktop","version":"tutorial-3"}');
check('a cold read reports unread sources as not read, and a finished one with nothing as failing', !O.sourceRows({ crawl: { running: true } })[0][5] && !O.sourceRows({ crawl: { running: true } })[0][4] && /Not read/.test(O.sourceRows({ crawl: { running: false, finished_ms: 1 } })[0][4]));
check('…and the short-record notice waits for a read', !O.issuesOf({ crawl: { running: true }, history: [] }).some((x) => /Daily record/.test(x.title)) && O.issuesOf({ crawl: { running: false, finished_ms: 1 }, history: [] }).some((x) => /Daily record/.test(x.title)));

// ── The card ──
const calls = () => (w.__HARNESS_CALLS__ || []).filter((c) => c.cmd === 'terminal_onboarding');
const card = T.add('onboarding', {}, 3);
const id = (card && card.id) || 'onboarding-1';
const host = await until(() => {
  const c = d.querySelector('#tm-grid .tm-card[data-card="' + id + '"] .tm-body');
  return c && c.querySelector('.ob-kpi') ? c : null;
});
check('the card renders', host !== null);
if (host) {
  const go = async (label, view) => {
    [...host.querySelectorAll('.ob-sections .sui-screen-nav-item')].find((a) => text(a) === label).click();
    if (view) {
      await until(() => host.querySelector('.ob-subnav'));
      [...host.querySelectorAll('.ob-subnav .sui-screen-nav-item')].find((a) => text(a) === view).click();
    }
    await until(() => host.querySelector('.ob[data-page="' + (PAGE[label] || label.toLowerCase()) + '"]'));
  };
  const kpiText = (k) => { const t = host.querySelector('.ob-tile[data-kpi="' + k + '"]'); return t && [...t.querySelectorAll('.ob-tile-stage, .ob-tile-scope, .ob-tile-label, .fstat-v, .ob-tile-sub, .ob-delta')].map(text).join(' ').toUpperCase(); };
  const sections = [...host.querySelectorAll('.ob-sections .sui-screen-nav-item')].map(text);
  check('six sections in journey order: Pirate, Join, Learn, Stay, Leaving, then Data', sections.join('|') === 'Pirate|Join|Learn|Stay|Leaving|Data', sections.join('|'));
  check('one read, asked with the fixed 7-day windows and no filter, humans only', calls().length >= 1 && calls()[0].args.idleHours === 168 && calls()[0].args.activeDays === 7 && !calls()[0].args.filters.compare && calls()[0].args.filters.replicants === false, JSON.stringify(calls()[0] || null));
  check('the scope bar: guild, app, version, split — no population or activity control', [...host.querySelectorAll('.ob-scope [data-control]')].map((n) => n.dataset.control).join(',') === 'guild,iface,version,compare', [...host.querySelectorAll('.ob-scope [data-control]')].map((n) => n.dataset.control).join(','));

  // ── Pirate ──
  const fg = (k) => host.querySelector('.ob-fg-row[data-funnel="' + k + '"]');
  const fgText = (k) => fg(k) && [...fg(k).querySelectorAll('.ob-fg-stage, .ob-fg-label, .ob-fg-value')].map(text).join(' ');
  check('PIRATE opens on telemetry\'s coverage: tracked of joined, and the guild that sent none', /^Telemetry saw 15 of 46\s*joined since Oct 24\s*· ONE sent none \(22\)\s*Coverage$/.test(text(host.querySelector('.ob-coverage'))), text(host.querySelector('.ob-coverage')));
  check('…then the pulse: calendar counts over the window, in one strip, named as such', [...host.querySelectorAll('.ob-kpi .ob-tile')].map((t) => t.dataset.kpi).join() === 'new,active,active_users,activated' && /^Pulse · last 30 days$/.test(text(host.querySelector('.ob-kpi-head .ob-chip'))) && /^ACQUISITION JOINED 225/.test(kpiText('new')) && /^ACTIVATION NEWLY ACTIVATED 40 20 OF THEM JOINED IN THE WINDOW/.test(kpiText('activated')), kpiText('new') + ' | ' + kpiText('activated'));
  check('…a windowed tile carries its change against the window before, coloured by direction', /\+62 · 38% VS PRIOR 30D/.test(kpiText('new')) && host.querySelector('.ob-tile[data-kpi="new"] .ob-delta.is-up') && host.querySelector('.ob-tile[data-kpi="activated"] .ob-delta.is-flat'), kpiText('new'));
  check('…both ends from one series, and only when that series reproduces the figure; otherwise it says the sources differ', O.deltaFor(288, [1, 1, 1, 1], 2, 'daily').mismatch && O.deltaFor(2, [1, 1, 1, 1], 2, 'daily').change === 0 && O.deltaOf([1, null, 1, 1], 2, 'daily') === null && O.shareOf(1, 5, 'signup opens') === '1 of 5 signup opens');
  const tsv = O.tsvOf(host.querySelector('.ob-kpi'));
  check('…and the strip copies as a report a sheet can use: value, previous, change, %, period and its dates', /^Figure\tValue\tPrevious\tChange\tChange %\tDetail\tPeriod\tDates\n/.test(tsv) && /\nJoined\t225\t163\t62\t38\.0%\t\t30 days\t\w{3} \d+–\w{3} \d+/.test(tsv), tsv.slice(0, 300));
  check('THE FUNNEL: sessions, then the joiners, every stage in the owner\'s words', [...host.querySelectorAll('.ob-fg-row')].map((r) => r.dataset.funnel).join() === 'visited,started,signed,joined,acted,refined_or_raided,activated,playing,referred' && fgText('joined') === 'Acquisition Joined 60' && fgText('activated') === 'Activation Activated 6' && fgText('playing') === 'Retention Played this week 9' && fg('visited').classList.contains('is-missing'), [...host.querySelectorAll('.ob-fg-row')].map((r) => fgText(r.dataset.funnel)).join(' | '));
  check('…each group says who and when: sessions, then who joined in the window and how many', /^Signup sessions · (last 30 days|since \w{3} \d+, (when telemetry began|the oldest reading))$/.test(text(host.querySelector('.ob-fg-group[data-group="sessions"]'))) && /^Joined \w{3} \d+ – today · 60 players$/.test(text(host.querySelector('.ob-fg-group[data-group="players"]'))) && text(host.querySelector('.ob-fg-group[data-group="every"]')) === 'Of everyone who joined · 60', [...host.querySelectorAll('.ob-fg-group')].map(text).join(' | '));
  check('…each share says what it is of: a percentage at twenty or more, "6 of 18" below', /67% of joined/.test(text(fg('acted'))) && /6 of 18 refined or raided/.test(text(fg('activated'))) && !/%/.test(text(fg('activated'))) && /15% of joined/.test(text(fg('playing'))), [fgText('acted'), text(fg('activated')), text(fg('playing'))].join(' | '));
  check('…refined and raided as two bars side by side, with their counts', fg('refined_or_raided').querySelectorAll('.ob-fg-parts .ob-fg-bar').length === 2 && /refined 10 · raided 14/.test(text(fg('refined_or_raided'))));
  check('…what is not recorded says so: referral; sessions the record covers only in part say since when', fg('referred').classList.contains('is-missing') && /not recorded/.test(text(fg('referred'))) && /^Signup sessions · since \w{3} \d+, (when telemetry began|the oldest reading)$/.test(text(host.querySelector('.ob-fg-group[data-group="sessions"]'))));
  check('…bars only narrow within a group', (() => { const wd = (k) => parseFloat(fg(k).querySelector('.ob-fg-bar').style.width); return wd('joined') === 100 && wd('acted') < 100 && wd('activated') < wd('acted'); })());
  check('…and players whose ledger is unread are counted apart, not as zeros', /^3 not read yet$/.test(text([...host.querySelectorAll('.ob-block[data-block="funnel"] .ob-chip')].pop())));
  const wrow = (i) => host.querySelectorAll('.ob-weeks .ob-row[data-week]')[i];
  check('BY JOIN WEEK: newest first, the same funnel a row per week', host.querySelectorAll('.ob-weeks .ob-row[data-week]').length === 12 && [...host.querySelector('.ob-weeks .ob-head').children].map(text).join('|') === 'Week of|Joined|Acted|Refined|Raided|Activated|Week 1|Week 2|Week 4|Played this week', [...host.querySelector('.ob-weeks .ob-head').children].map(text).join('|'));
  check('…a week too young for a stage says not yet, never a zero', text(wrow(0).children[6]) === 'not yet' && text(wrow(2).children[6]) !== 'not yet' && text(wrow(2).children[7]) === 'not yet' && text(wrow(11).children[8]) !== 'not yet', [0, 2, 11].map((i) => text(wrow(i))).join(' | '));
  check('…one unit, players, in every cell; the share of the week\'s joiners on hover once there are twenty', text(wrow(0).children[2]) === '6' && text(wrow(1).children[2]) === '49' && /^49 of 70 · 70%$/.test(wrow(1).children[2].title) && !/%/.test(wrow(0).children[2].title), text(wrow(0).children[2]) + ' | ' + text(wrow(1).children[2]) + ' | ' + wrow(1).children[2].title);
  check('…and a week before exact join dates is marked as approximate', /^≈ /.test(text(wrow(11).children[0])) && !/^≈/.test(text(wrow(0).children[0])));
  check('…and the same faint mark on its week columns', wrow(11).children[6].classList.contains('is-partial') && !wrow(1).children[6].classList.contains('is-partial'));
  check('THREE DOORS: the biggest leak, the learning gap and who came back', [...host.querySelectorAll('.ob-pirate-doors .ob-tile')].map((t) => t.dataset.kpi).join() === 'door_leaving,door_learn,door_stay' && /^BIGGEST LEAK ALL TIME NEVER ACTED ON CHAIN 4,800/.test(kpiText('door_leaving')) && /^LEARN SINCE \w{3} \d+ TUTORIAL FINISHERS WHO RAIDED 6 6 OF 12 FINISHERS/.test(kpiText('door_learn')), kpiText('door_leaving') + ' | ' + kpiText('door_learn'));
  check('…old Overview blocks are gone: no signals, no journey', !host.querySelector('.ob-signal') && !host.querySelector('.ob-journey-table') && !host.querySelector('.ob-aarrr'));
  check('…and splits are the four the design keeps: no activity or replicant split', [...host.querySelectorAll('.ob-scope [data-control="compare"] option')].map((o) => o.value).join() === ',interface,guild,version,tutorial');
  const before = calls().length;
  host.querySelectorAll('.ob-kpi-head .ob-windows .sui-screen-nav-item')[1].click();
  await until(() => /JOINED 54/.test(kpiText('new') || ''));
  check('the window is a param: 7 days redraws the pulse and the funnel without asking again', /JOINED 54/.test(kpiText('new')) && fgText('joined') === 'Acquisition Joined 12' && calls().length === before, kpiText('new'));
  check('…and the copied word reopens it', O.wordOf({ win: '7' }) === 'TELEMETRY 7d' && host.querySelector('.ob-act[data-act="word"]').title === 'TELEMETRY 7d');
  host.querySelectorAll('.ob-kpi-head .ob-windows .sui-screen-nav-item')[3].click();
  await until(() => fgText('joined') === 'Acquisition Joined 300');
  check('ALL TIME: the funnel over every joiner with an exact date, the pulse as totals', fgText('joined') === 'Acquisition Joined 300' && /^Joined since Sep 24 \(exact join dates\) · 300 players$/.test(text(host.querySelector('.ob-fg-group[data-group="players"]'))) && /^ACQUISITION JOINED 9,600/.test(kpiText('new')) && O.wordOf({ win: 'all' }) === 'TELEMETRY all' && JSON.stringify(O.parseArgs('pirate all')) === '{"page":"overview","win":"all"}', fgText('joined') + ' | ' + kpiText('new'));
  host.querySelectorAll('.ob-kpi-head .ob-windows .sui-screen-nav-item')[1].click();
  await until(() => /JOINED 54/.test(kpiText('new') || ''));

  // ── Acquisition ──
  await go('Join');
  check('sections switch from the last read, without asking again', calls().length === before);
  check('the card is titled by its section', /Telemetry · Join/.test(text(d.querySelector('#tm-grid .tm-card[data-card="' + id + '"] .tm-title'))), text(d.querySelector('#tm-grid .tm-card[data-card="' + id + '"] .tm-title')));
  check('JOIN: the same signup and new-player figures on the same window, then the all-time funnel figures', /STARTED SIGNUP 21/.test(kpiText('opens')) && /^ALL TIME NEVER FINISHED 1,049 49% OF 2,140 STARTS/.test(kpiText('dropoff')) && /SIGNUP TAKES 4 MIN/.test(kpiText('signup_time')) && /JOINED 54/.test(kpiText('new')), kpiText('dropoff') + ' | ' + kpiText('signup_time'));
  const steps = [...host.querySelectorAll('.ob-funnel .ob-row[data-step]')];
  check('…the signup funnel lists every step', steps.some((r) => r.dataset.step === 'signup.connecting') && steps.some((r) => r.dataset.step === 'signup.employee_record'), steps.length);
  const create = steps.find((r) => r.dataset.step === 'signup.recovery_key_create');
  check('…the worst stop rates are flagged, count and rate, to one decimal', create && create.querySelectorAll('.is-bad').length === 2 && text(create.children[5]) === '16.0%', create && text(create));
  check('…and only a real excess over the typical step is flagged', JSON.stringify(O.worstRates([{ key: 'a', r: 100, s: 10 }, { key: 'b', r: 100, s: 11 }, { key: 'c', r: 100, s: 30 }, { key: 'd', r: 100, s: 9 }], (x) => x.r, (x) => x.s, 3)) === '["c"]');
  const last = steps.find((r) => r.dataset.step === 'signup.employee_record');
  check('…a last step has no stop figure, a dash and not a zero', last && text(last.children[4]) === '—' && text(last.children[5]) === '—', last && text(last));
  const faq = steps.findIndex((r) => r.dataset.step === 'signup.recovery_key_faq');
  check('…a side branch sits under the step it branches from, and is not a step', faq > 0 && steps[faq - 1].dataset.step.startsWith('signup.recovery_key') && steps[faq].classList.contains('is-aside') && text(steps[faq].children[3]) === '—', steps.map((r) => r.dataset.step).join(','));
  check('…with its own figures over time', !!host.querySelector('.ob-block[data-block="trends"] .ob-trends .ob-row[data-trend="signed_up"]'));
  check('JOIN reads guild, app, version and split', !host.querySelector('.ob-scope [data-control="guild"]').disabled && !host.querySelector('.ob-scope [data-control="iface"]').disabled);

  // ── Learn ──
  await go('Learn');
  check('LEARN: players, take-up, finished, skipped, quit, time', ['players', 'takeup', 'finished', 'skipped', 'quit', 'time'].every((k) => host.querySelector('.ob-tile[data-kpi="' + k + '"]')) && /^TAKE-UP 83%/.test(kpiText('takeup')), kpiText('takeup'));
  check('…views: steps, first moves, after the tutorial, runs — above the figures', [...host.querySelectorAll('.ob-subnav .sui-screen-nav-item')].map(text).join('|') === 'Steps|First moves|After the tutorial|Runs' && host.querySelector('.ob-subnav').compareDocumentPosition(host.querySelector('.ob-kpi')) & 4);
  check('STEPS: the outcome strip', host.querySelectorAll('.ob-stack .ob-seg').length === 4);
  check('…one step table, unique players first, time a column', /Steps · 920 unique players/.test(text(host.querySelector('.ob-block[data-block="steps"] .ob-title'))) && [...host.querySelector('.ob-steps .ob-head').children].map(text).includes('Median'));
  const combat = host.querySelector('.ob-steps .ob-row[data-step="tutorial.first_attack.combat"]');
  check('…a step with known leavers can be opened, one without cannot', combat && combat.querySelector('a.ob-drill') && !host.querySelector('.ob-steps .ob-row[data-step="tutorial.loading"] a.ob-drill'));
  combat.querySelector('a.ob-drill').click();
  const who = host.querySelector('.ob-steps .ob-who');
  check('…opening a step lists who stopped there, and says how many the servers did not list', who && who.querySelector('[data-player="1-9584"]') && /2 listed of 53 stopped/.test(text(who)), who && text(who));
  host.querySelector('.ob-steps .ob-row[data-step="tutorial.first_attack.combat"] a.ob-drill').click();
  [...host.querySelectorAll('.ob-count .sui-screen-nav-item')].find((a) => text(a) === 'Sessions').click();
  await until(() => host.querySelector('.ob-phases'));
  const phaseRow = (l) => host.querySelector('.ob-phases .ob-row[data-phase="' + l + '"]');
  check('…by sessions, the same table by phase: reached, kept, stopped, stop rate, skipped, time', phaseRow('Offer') && text(phaseRow('Offer').children[2]) === '1,102' && text(phaseRow('Offer').children[4]) === '215' && text(phaseRow('Offer').children[5]) === '19.5%' && phaseRow('Offer').children[5].classList.contains('is-bad') && text(phaseRow('Offer').children[6]) === '182', phaseRow('Offer') && text(phaseRow('Offer')));
  check('…a phase the design lacks is not drawn', !phaseRow('Free play') && !!phaseRow('First attack'));
  phaseRow('First attack').querySelector('a.ob-drill').click();
  const inner = host.querySelector('.ob-phases .ob-subtable');
  check('…a phase opens into its steps', inner && inner.querySelector('.ob-row[data-step="tutorial.first_attack.combat"]'));
  inner.querySelector('.ob-row[data-step="tutorial.first_attack.combat"] a.ob-drill').click();
  check('…and a step into the players who stopped there, with a door to all of them', /Kestrel/.test(text(host.querySelector('.ob-phases .ob-subtable .ob-who'))) && !!host.querySelector('.ob-phases .ob-who .ob-act[data-act="all_stopped"]'));
  host.querySelector('.ob-phases .ob-subtable .ob-row[data-step="tutorial.first_attack.combat"] a.ob-drill').click();
  phaseRow('First attack').querySelector('a.ob-drill').click();
  phaseRow('Offer').querySelector('a.ob-drill').click();
  const offer = host.querySelector('.ob-phases .ob-subtable .ob-row[data-step="orientation.tutorial_offer"]');
  check('…the offer\'s steps carry their skips', offer && text(offer.children[6]) === '182' && text(offer.children[7]) === '17%', offer && text(offer));
  phaseRow('Offer').querySelector('a.ob-drill').click();
  check('…and how long each part takes sits under the table', host.querySelectorAll('.ob-durations .ob-row[data-metric]').length === 6);
  await go('Learn', 'First moves');
  check('FIRST MOVES: of who joined in the window (7 days here), how many and how long after joining; under twenty reads as a count', [...host.querySelectorAll('.ob-tile')].map((t) => t.dataset.kpi).join() === 'first_mined,first_refined,first_raided,first_activated' && /^ACTIVATION REFINED 2 2 OF 12 JOINED · TYPICALLY 1.2 D AFTER JOINING$/.test(kpiText('first_refined')) && /TYPICALLY 43 MIN AFTER JOINING/.test(kpiText('first_raided')), kpiText('first_refined') + ' | ' + kpiText('first_raided'));
  const frow = (i) => host.querySelectorAll('.ob-first .ob-row[data-week]')[i];
  check('…then by join week, newest first, each move with its typical delay', host.querySelectorAll('.ob-first .ob-row[data-week]').length === 12 && /^14 ?after 1.5 d$/.test(text(frow(1).children[4])) && /^\d+ ?after 10 h$/.test(text(frow(1).children[3])), frow(1) && text(frow(1)));
  host.querySelectorAll('.ob-kpi-head .ob-windows .sui-screen-nav-item')[3].click();
  await until(() => /ACTIVATED 30/.test(kpiText('first_activated') || ''));
  check('…all time is a window here too, and reads back as a word', /^ACTIVATION ACTIVATED 30 10% OF JOINED/.test(kpiText('first_activated')) && host.querySelector('.ob-act[data-act="word"]').title === 'TELEMETRY onboarding first all', kpiText('first_activated'));
  host.querySelectorAll('.ob-kpi-head .ob-windows .sui-screen-nav-item')[1].click();
  await until(() => /ACTIVATED 1\b/.test(kpiText('first_activated') || ''));
  await go('Learn', 'Runs');
  check('RUNS: players, runs, finished, quit, no player', /^PLAYERS 31/.test(kpiText('run_players')) && /^RUNS 40 9 REPEAT/.test(kpiText('runs')) && /^FINISHED 24 60% OF RUNS/.test(kpiText('run_finished')) && /^NO PLAYER 2/.test(kpiText('no_player')), kpiText('runs'));
  const logged = host.querySelector('.ob-runs .ob-row[data-session="aaaa"]');
  check('…a run is listed by interface, kind, outcome and time', logged && /1-194/.test(text(logged.children[0])) && text(logged.children[2]) === 'Desktop app' && text(logged.children[5]) === 'Existing' && text(logged.children[6]) === 'Finished' && /10m/.test(text(logged.children[8])), logged && text(logged));
  const nameless = host.querySelector('.ob-runs .ob-row[data-session="cccc"]');
  check('…a run nobody is attached to says so and offers no player link', nameless && text(nameless.children[0]) === 'No player' && !nameless.querySelector('a'), nameless && text(nameless));
  const byRun = [...host.querySelectorAll('.ob-run-compare .ob-row[data-run]')];
  check('…first runs beside later ones', byRun.length === 2 && text(byRun[0].children[0]) === 'First run' && text(byRun[1].children[2]) === '6 of 10', byRun.map(text).join(' | '));
  await go('Learn', 'After the tutorial');
  const grp = (k) => host.querySelector('.ob-impact .ob-row[data-group="' + k + '"]');
  check('AFTER THE TUTORIAL: one row per tutorial outcome, then everyone; only a group of twenty or more can be marked best', ['finished', 'quit', 'skipped', 'none', 'all'].every((k) => grp(k)) && /^5 ?of 12$/.test(text(grp('finished').children[5])) && !grp('finished').querySelector('.is-best') && grp('none').children[5].classList.contains('is-best') && grp('finished').classList.contains('is-small'), grp('finished') && text(grp('finished')));

  // ── Stay ──
  await go('Stay');
  check('STAY: active users, anyone active, coming back daily, played', [...host.querySelectorAll('.ob-tile')].map((t) => t.dataset.kpi).join() === 'active_users,active,stickiness,played' && /ACTIVE THIS WEEK 192/.test(kpiText('active')) && /^RETENTION LAST 30 DAYS PLAYED 31/.test(kpiText('played')), kpiText('active') + ' | ' + kpiText('played'));
  const tri = [...host.querySelectorAll('.ob-triangle .ob-cohort[data-week]')];
  check('…the triangle: a row per join week, oldest first, a cell per week since joining, blank where not lived yet', tri.length === 12 && tri[0].querySelectorAll('.ob-heat-none').length === 0 && tri[11].querySelectorAll('.ob-heat-none').length === 8 && /^≈ /.test(text(tri[0].children[0])), tri.map((r) => r.querySelectorAll('.ob-heat-none').length).join());
  check('…players in every cell, shaded by share of the week\'s joiners, a small week a quiet count', /^\d+$/.test(text(tri[0].children[3])) && /^8 of 20 · 40%/.test(tri[0].children[3].title) && tri[0].children[3].classList.contains('ob-heat-2') && tri[11].children[2].classList.contains('ob-heat-count') && text(tri[11].children[2]) === '6', tri[0].children[3].title + ' | ' + [...tri[0].children].map((c) => c.className).join(','));
  check('…a week after joining that began before the activity feed reaches is drawn faint, and says why', tri[0].querySelectorAll('.ob-heat.is-partial').length === 8 && tri[10].querySelectorAll('.ob-heat.is-partial').length === 0 && /only mines, refines and raids count/.test(tri[0].querySelector('.ob-heat.is-partial').title), [0, 10].map((i) => tri[i].querySelectorAll('.ob-heat.is-partial').length).join());
  check('…days played in the last 30', /^Days played/.test(text(host.querySelector('.ob-block[data-block="captivated"] .ob-title'))));
  const au = [...host.querySelectorAll('.ob-active-users .ob-row[data-player]')];
  check('…and the active users by name, most days played first, saying how many are listed', au.map((r) => r.dataset.player).join() === '1-61,1-195' && /^Active users · 3$/.test(text(host.querySelector('.ob-block[data-block="active_users"] .ob-title'))) && /2 listed of 3/.test(text(host.querySelector('.ob-block[data-block="active_users"]'))));

  // ── Leaving ──
  await go('Leaving');
  const lrow = (k) => host.querySelector('.ob-furthest .ob-row[data-bucket="' + k + '"]');
  check('LEAVING: everyone gone a week, each once, by how far they got', [...host.querySelectorAll('.ob-furthest .ob-row[data-bucket]')].map((r) => r.dataset.bucket).join() === 'never_acted,acted_only,mined_only,refined_no_raid,raided_no_refine,activated' && /^Gone 7 days · 8,448 of 9,600 players$/.test(text(host.querySelector('.ob-block[data-block="furthest"] .ob-chip'))) && /^Never acted on chain ?4,800 ?57%/.test(text(lrow('never_acted'))), text(host.querySelector('.ob-block[data-block="furthest"]')).slice(0, 300));
  check('…the shares add up: every leaver is in exactly one row', [...host.querySelectorAll('.ob-furthest .ob-row[data-bucket]')].reduce((a, r) => a + Number(text(r.children[1]).replace(/,/g, '')), 0) === 8448);
  lrow('never_acted').querySelector('a.ob-drill').click();
  const lwho = host.querySelector('.ob-furthest .ob-who');
  check('…a row opens the players behind it, saying how many are listed', lwho && lwho.querySelector('[data-player="1-9601"]') && /2 listed of 4,800/.test(text(lwho)) && /never acted/.test(text(lwho)), lwho && text(lwho));
  lrow('never_acted').querySelector('a.ob-drill').click();
  const stuck = host.querySelector('.ob-block[data-block="stuck"]');
  check('STUCK: the last step recorded signups reached, then the finishers on chain afterwards', stuck && /Left in Offer/.test(text(stuck)) && /Finished Combat Training/.test(text(stuck)) && /^Initiated a raid ?6 ?6 of 12$/.test(text(stuck.querySelector('.ob-after .ob-row[data-after="raided"]'))), stuck && text(stuck).slice(0, 400));
  const cap = host.querySelector('.ob-block[data-block="captivated"]');
  check('CAPTIVATED: days played in the last 30, of those who played, and what is not read yet', cap && /Days played, last 30 · 31 players/.test(text(cap)) && /12 activity not read/.test(text(cap)) && /^4–7 days ?7/.test(text(cap.querySelector('.ob-row[data-played="4-7"]'))) && /^15–30 days ?1/.test(text(cap.querySelector('.ob-row[data-played="15-30"]'))), cap && text(cap).slice(0, 300));
  const conf = host.querySelector('.ob-block[data-block="confused"]');
  check('CONFUSED: the signs we record carry a count, the rest say not recorded', conf && /^Replayed Combat Training ?6/.test(text(conf.querySelector('[data-sign="replays"]'))) && /not recorded/.test(text(conf.querySelector('[data-sign="failed_tx"]'))) && /not recorded/.test(text(conf.querySelector('[data-sign="help"]'))), conf && text(conf));
  check('LAST SEEN lives here now: every player in one bucket', ['today', 'week', 'month', 'gone', 'never'].every((k) => host.querySelector('.ob-key[data-life="' + k + '"]')));
  check('…TELEMETRY leaving and stuck open it', JSON.stringify(pp('TELEMETRY leaving')) === '{"page":"leaving"}' && JSON.stringify(pp('TELEMETRY stuck')) === '{"page":"leaving"}');

  // ── The named lists, where their counts are ──
  await go('Join');
  const p = () => host.querySelector('.ob-recent .ob-row[data-player="1-9580"]');
  check('JOIN ends with the newest signups by name, with outcome and time in the tutorial', p() && /Finished/.test(text(p())) && /13m/.test(text(p())) && /^Newest signups · 3/.test(text(host.querySelector('.ob-block[data-block="list_signups"] .ob-title'))), p() && text(p()));
  const dots = (pid) => host.querySelector('.ob-recent .ob-row[data-player="' + pid + '"]').querySelectorAll('.ob-dot');
  check('…a journey is a square per phase, filled to the last reached', dots('1-9584').length === 11 && dots('1-9584')[5].classList.contains('is-done') && dots('1-9584')[6].classList.contains('ob-badge-playing'));
  host.querySelector('.ob-block[data-block="list_signups"] .ob-pill[data-outcome="declined"]').click();
  check('…an outcome narrows the list', [...host.querySelectorAll('.ob-recent .ob-row[data-player]')].map((r) => r.dataset.player).join() === '1-9571');
  host.querySelector('.ob-block[data-block="list_signups"] .ob-pill[data-outcome="all"]').click();
  const q = host.querySelector('.ob-search[data-list="signups"] input');
  q.value = 'kest'; q.dispatchEvent(new w.Event('input'));
  await until(() => host.querySelectorAll('.ob-recent .ob-row[data-player]').length === 1);
  check('…a name finds a player', [...host.querySelectorAll('.ob-recent .ob-row[data-player]')].map((r) => r.dataset.player).join() === '1-9584');
  host.querySelector('.ob-search[data-list="signups"] input').value = ''; host.querySelector('.ob-search[data-list="signups"] input').dispatchEvent(new w.Event('input'));
  await until(() => host.querySelectorAll('.ob-recent .ob-row[data-player]').length === 3);
  host.querySelector('.ob-recent .ob-sort[data-sort="player"]').click();
  check('…a caption sorts, the same way in every list', [...host.querySelectorAll('.ob-recent .ob-row[data-player]')].map((r) => r.dataset.player).join() === '1-9580,1-9584,1-9571', [...host.querySelectorAll('.ob-recent .ob-row[data-player]')].map((r) => r.dataset.player).join());
  await go('Leaving');
  check('LEAVING ends with everyone named as stopping, the step said once', host.querySelectorAll('.ob-stopped .ob-row[data-player]').length === 2 && text(host.querySelector('.ob-stopped .ob-row[data-player="1-9584"]').children[1]) === 'First attack · Combat' && /2 of 53/.test(text(host.querySelector('.ob-block[data-block="list_stopped"] .ob-chip'))));

  // ── Data ▸ Guilds ──
  await go('Data', 'Guilds');
  const g = [...host.querySelectorAll('.ob-guilds .ob-row[data-guild]')];
  const sn = g.find((r) => r.dataset.guild === '0-5');
  check('DATA ▸ GUILDS: biggest first, with no guild as its own quiet row', g.map((r) => r.dataset.guild).join(',') === '0-5,0-1,0-2,none' && g.find((r) => r.dataset.guild === 'none').classList.contains('is-quiet'), g.map((r) => r.dataset.guild).join(','));
  check('…signup and tutorial finish rates, with their counts; a guild with no API is a dash', /^52% ?1,101 of 2,136$/.test(text(sn.children[5])) && /^37% ?402 of 1,101$/.test(text(sn.children[6])) && text(g.find((r) => r.dataset.guild === '0-2').children[5]) === '—');
  check('…each reporting guild has a Focus door and a Stopped door', !!sn.querySelector('[data-act="focus"]') && !!sn.querySelector('[data-act="stopped"]') && !g.find((r) => r.dataset.guild === '0-2').querySelector('[data-act="stopped"]'));
  sn.querySelector('a.ob-drill').click();
  const more = () => host.querySelector('.ob-guilds .ob-more[data-more="0-5"]');
  check('…a row opens the rest, with the same drill', more() && /Runs ?37/.test(text(more())) && /3,810 \/ 3,810/.test(text(more())), more() && text(more()));
  host.querySelector('.ob-guilds .ob-row[data-guild="0-5"] a.ob-drill').click();
  check('…and closes again', !more());

  // ── Data ▸ Daily record ──
  await go('Data', 'Daily record');
  const tr = (k) => host.querySelector('.ob-trends .ob-row[data-trend="' + k + '"]');
  check('DAILY RECORD: each figure with its line, latest, a week and a month: a change signed, a count not', tr('humans') && tr('humans').querySelector('svg') && text(tr('humans').children[2]) === '478' && text(tr('humans').children[3]) === '+14', tr('humans') && text(tr('humans')));
  check('…grouped by the stage they measure', [...host.querySelectorAll('.ob-trends .ob-row.is-part')].map(text).join('|') === 'Awareness|Acquisition|Onboarding|Activation|Retention|Population', [...host.querySelectorAll('.ob-trends .ob-row.is-part')].map(text).join('|'));
  check('…a server figure starts when the record does', tr('signed_up') && text(tr('signed_up').children[2]) === '119' && text(tr('signed_up').children[4]) === '—', tr('signed_up') && text(tr('signed_up')));
  check('…rows stored under the old name read as acted, in one line', tr('acted') && text(tr('acted').children[2]) === '189');
  const charts = () => d.querySelectorAll('#tm-grid .tm-card[data-type="chart"]').length;
  const c0 = charts();
  tr('humans').querySelector('a.ob-link').click();
  check('…a figure opens as a chart', !!(await until(() => charts() > c0)));
  const pick = (k) => { const b = tr(k).querySelector('.ob-pick input'); b.checked = true; b.dispatchEvent(new w.Event('change')); };
  pick('humans'); await until(() => tr('humans').classList.contains('is-picked'));
  pick('active_7d'); await until(() => tr('active_7d').classList.contains('is-picked'));
  const many = host.querySelector('.ob-act[data-act="chart_picked"]');
  check('…ticked figures chart together', many && text(many) === 'Chart 2');
  many.click();
  const lastChart = await until(() => { const cs = [...d.querySelectorAll('#tm-grid .tm-card[data-type="chart"]')]; return cs.length > c0 + 1 ? cs[cs.length - 1] : null; });
  const layoutCard = lastChart && T.state && T.state.layout ? T.state.layout.cards.find((c) => c.id === lastChart.dataset.card) : null;
  check('…as one chart card with both series', !!lastChart && (!layoutCard || JSON.parse(layoutCard.params.series).map((s) => s.metric).join() === 'humans,active_7d'));
  check('DATA reads the guild alone', !host.querySelector('.ob-scope [data-control="guild"]').disabled && host.querySelector('.ob-scope [data-control="iface"]').classList.contains('is-off'));
  check('…and the sampled days sit under the figures, newest first', host.querySelectorAll('.ob-daily .ob-row[data-day]').length === 6);
  check('…a section\'s own figures door here', JSON.stringify(pp('TELEMETRY trends')) === '{"page":"data","view":"record"}');

  // ── Data ──
  await go('Data');
  const srcs = [...host.querySelectorAll('.ob-sources .ob-row[data-source]')];
  check('DATA: every source and what it holds', srcs.length === 9 && /7,667 confirmed · 1,500 suspected/.test(text(srcs[2])) && /from the guild/.test(text(srcs[2])), srcs.map(text).join(' | '));
  check('…test accounts by name, left out', /^Test accounts ?2 by name ?left out/.test(text(srcs[1])), text(srcs[1]));
  const tb = host.querySelector('.ob-block[data-block="tests"]');
  check('…and who the name rule caught, newest first, each a player door', tb && /Test accounts · 2/.test(text(tb)) && /Left out of every figure/.test(text(tb)) && [...tb.querySelectorAll('.ob-row[data-player]')].map((r) => r.dataset.player).join() === '1-14649,1-7565', tb && text(tb));
  check('…a guild read per guild', host.querySelectorAll('.ob-guild-reads .ob-row[data-guild]').length === 3 && /3,810 \/ 3,810/.test(text(host.querySelector('.ob-guild-reads .ob-row[data-guild="0-5"]'))));
  const iss = [...host.querySelectorAll('.ob-issues .ob-issue')].map((r) => r.dataset.issue);
  check('…leads with what is wrong, worst first, and says when the sources disagree', iss.join('|') === 'Replicants read from the guild|Guilds send no telemetry|Runs with no player|Sources disagree', iss.join('|'));
  const rec = (k) => host.querySelector('.ob-reconcile .ob-row[data-figure="' + k + '"]');
  check('…the chain and the daily record side by side, a disagreement marked', rec('Joined, 30 days') && /agree/.test(text(rec('Joined, 30 days'))) && /^Active this month ?576 ?149 ?-427$/.test(text(rec('Active this month'))), rec('Active this month') && text(rec('Active this month')));
  check('…lost beacons name the guild, with the count', /SN\.C/.test(text(host.querySelector('.ob-issue[data-issue="Runs with no player"]'))) && /2 of 40 runs/.test(text(host.querySelector('.ob-issue[data-issue="Runs with no player"]'))));
  check('the status link counts issues, not notices, and opens Data', /^2 issues/.test(text(host.querySelector('.ob-status'))), text(host.querySelector('.ob-status')));
  check('…coverage counts players, split by why they are unseen', /In reporting guilds ?9,340/.test(text(host.querySelector('.ob-key[data-coverage="ok"]'))) && /In guilds with no API ?72/.test(text(host.querySelector('.ob-key[data-coverage="dark"]'))) && /In no guild ?188/.test(text(host.querySelector('.ob-key[data-coverage="none"]'))));
  check('…an issue is a door, with what fixes it on hover', host.querySelector('.ob-issue[data-issue="Runs with no player"]').tagName === 'A' && /launch message was lost/.test(host.querySelector('.ob-issue[data-issue="Runs with no player"]').title));
  check('…the footer counts humans and names the replicants set aside', /of 445 humans/.test(text(host.querySelector('.ob-foot'))) && /9,167 replicants under 9 primaries/.test(text(host.querySelector('.ob-foot'))), text(host.querySelector('.ob-foot')));
  const sel = (k) => host.querySelector('[data-control="' + k + '"]');
  check('DATA opens on health: views for guilds, the daily record, distributions and the dictionary', [...host.querySelectorAll('.ob-subnav .sui-screen-nav-item')].map(text).join('|') === 'Health|Guilds|Daily record|Distributions|Dictionary');
  check('SETTINGS: no active or quit window to set: both are fixed at 7 days', !sel('active') && !sel('idle') && calls().every((c) => c.args.idleHours === 168 && c.args.activeDays === 7));
  await go('Data', 'Dictionary');
  check('DICTIONARY: every definition, listed once', host.querySelectorAll('.ob-defs .ob-row[data-term]').length >= 15);
  await go('Data', 'Distributions');
  check('DISTRIBUTIONS live on Data: five, each with its histogram, then play length', (() => { const b = [...host.querySelectorAll('.ob-block[data-block="dist"]')]; return b.length === 6 && /Ore mined/.test(text(b[0])) && /Raids won/.test(text(b[4])) && b[0].querySelectorAll('.ob-hist .ob-row:not(.ob-head)').length === 7; })());
  await go('Data', 'Health');
  await until(() => host.querySelector('.ob-ex-switch input'));
  const exSw = () => host.querySelector('.ob-ex-switch input');
  check('…excluded players are left out unless asked for', exSw() && !exSw().checked && calls().at(-1).args.filters.include_excluded === false);
  exSw().checked = true; exSw().dispatchEvent(new w.Event('change'));
  check('…the switch re-reads with everyone', !!(await until(() => calls().find((c) => c.args.filters.include_excluded === true))));
  await until(() => exSw() && exSw().checked);
  check('…and every page then says excluded players are in', /excluded in/.test(text(host.querySelector('.ob-status'))) && !/quit|active \d/.test(text(host.querySelector('.ob-status'))), text(host.querySelector('.ob-status')));
  exSw().checked = false; exSw().dispatchEvent(new w.Event('change'));
  await until(() => calls().at(-1).args.filters.include_excluded === false && exSw() && !exSw().checked);

  // ── Split ──
  const split = async (v) => { sel('compare').value = v; sel('compare').dispatchEvent(new w.Event('change')); await until(() => calls().find((c) => c.args.filters.compare === (v || null)) && (!v || host.querySelector('.ob-seglabel'))); };
  await go('Pirate');
  await split('guild');
  check('a split is a param, re-reads, and marks the scope bar', calls().at(-1).args.filters.compare === 'guild' && sel('compare').classList.contains('is-set') && !!host.querySelector('.ob-reset'));
  await until(() => host.querySelector('.ob-kpi-table'));
  const head = [...host.querySelectorAll('.ob-kpi-table .ob-head .ob-c')].map(text);
  check('PIRATE splits the pulse into one column per segment, each with its swatch', head.join('|') === '|OH|SN.C|Sum' && host.querySelectorAll('.ob-kpi-table .ob-head .ob-swatch').length === 2, head.join('|'));
  check('…the funnel is a column per segment', host.querySelectorAll('.ob-fg-col').length === 2);
  check('…the weeks get a table per segment', [...host.querySelectorAll('.ob-block[data-block="weeks"] .ob-title')].map(text).join('|') === 'By join week · OH|By join week · SN.C');
  check('…a split\'s pulse rows keep their names', [...host.querySelectorAll('.ob-kpi-table .ob-row[data-kpi]')].map((r) => text(r.children[0])).join('|') === 'Joined|Active this week|Active users|Newly activated', [...host.querySelectorAll('.ob-kpi-table .ob-row[data-kpi]')].map((r) => text(r.children[0])).join('|'));
  await go('Leaving');
  check('LEAVING splits how far they got into a column per segment', host.querySelectorAll('.ob-block[data-block="furthest"] .ob-compare .ob-head .ob-swatch').length === 2 && !!host.querySelector('.ob-block[data-block="furthest"] .ob-row[data-bucket="never_acted"]'));
  await go('Stay');
  check('STAY splits the triangle per segment', [...host.querySelectorAll('.ob-block[data-block="triangle"] .ob-title')].map(text).join('|') === 'Played, by weeks since joining · OH|Played, by weeks since joining · SN.C');
  await go('Data', 'Distributions');
  check('…distributions get a row per segment', [...host.querySelectorAll('.ob-dist .ob-row[data-seg]')].slice(0, 2).map((r) => r.dataset.seg).join(',') === '0-1,0-5');
  await go('Learn', 'Steps');
  const th = text(host.querySelector('.ob-funnel-compare .ob-head'));
  check('LEARN splits kept and stop rate per guild by phase, with the signed difference', /OH · Kept/.test(th) && /SN\.C · Stop rate/.test(th) && /Δ stop rate OH − SN\.C/.test(th) && !!host.querySelector('.ob-block[data-block="phases"] .ob-funnel-compare .ob-row[data-step="phase:2"]'), th);
  await go('Learn', 'Runs');
  check('RUNS split: the KPI table has a column per guild', /OH/.test(text(host.querySelector('.ob-kpi-table .ob-head'))) && host.querySelectorAll('.ob-kpi-table .ob-row[data-kpi]').length === 5);
  await split('tutorial');
  await go('Join');
  check('split by tutorial outcome, signup names why it has nothing', /The tutorial comes after signup/.test(text(host.querySelector('.ob-view'))));
  await go('Pirate');
  check('…and the funnel says each group has no signup record', host.querySelectorAll('.ob-fg-col').length === 4 && [...host.querySelectorAll('.ob-fg-row[data-funnel="started"]')].every((r) => r.classList.contains('is-missing')));
  host.querySelector('.ob-reset').click();
  await until(() => !calls().at(-1).args.filters.compare && !host.querySelector('.ob-reset'));
  await go('Data', 'Guilds');
  host.querySelector('.ob-guilds .ob-row[data-guild="0-5"] [data-act="stopped"]').click();
  await until(() => calls().find((c) => c.args.filters.guild === '0-5') && host.querySelector('.ob[data-page="leaving"] .ob-stopped'));
  check('a guild\'s Stopped door opens its stopped players, and only theirs', [...host.querySelectorAll('.ob-stopped .ob-row[data-player]')].map((r) => r.dataset.player).join() === '1-9584' && /SN\.C/.test(text(host.querySelector('.ob-block[data-block="list_stopped"] .ob-chip.is-set'))));
  check('…and the card title names the guild', /Telemetry · Leaving · 0-5/.test(text(d.querySelector('#tm-grid .tm-card[data-card="' + id + '"] .tm-title'))));
  host.querySelector('.ob-reset').click();
  await until(() => !calls().at(-1).args.filters.compare && !host.querySelector('.ob-reset'));
  check('Reset clears every filter and the split', !calls().at(-1).args.filters.compare && !host.querySelector('.ob-reset'));
  await go('Data');
  const repSw = () => host.querySelector('.ob-reps-switch input');
  check('the population lives in Data ▸ Settings: humans only unless asked', repSw() && !repSw().checked);
  repSw().checked = true; repSw().dispatchEvent(new w.Event('change'));
  check('…and is a param: humans + replicants', !!(await until(() => calls().find((c) => c.args.filters.replicants === true))));
  await until(() => /of 9,612 players/.test(text(host.querySelector('.ob-foot'))));
  check('…and the footer then counts every player', /of 9,612 players/.test(text(host.querySelector('.ob-foot'))), text(host.querySelector('.ob-foot')));
  check('while the crawl runs the status says so with the in-progress glyph', !!host.querySelector('.ob-status .icon-in-progress') && /Reading · read \d/.test(text(host.querySelector('.ob-status'))), text(host.querySelector('.ob-status')));
  check('every block can copy what it shows', /^Source\tHolds/.test(O.tsvOf(host.querySelector('.ob-block[data-block="sources"]'))), O.tsvOf(host.querySelector('.ob-block[data-block="sources"]')).slice(0, 60));
}

// ── Cold start: nothing read yet ──
w.__HARNESS_OB_COLD__ = 'reading';
const cold = T.add('onboarding', {}, 3);
const coldId = (cold && cold.id) || 'onboarding-2';
const coldHost = await until(() => {
  const c = d.querySelector('#tm-grid .tm-card[data-card="' + coldId + '"] .tm-body');
  return c && c.querySelector('.ob') ? c : null;
});
check('with nothing read and the crawl running, the page is a loading block, not zero tiles',
  coldHost && !coldHost.querySelector('.ob-hud') && coldHost.querySelector('.ob-main > .sui-message-inline-alert .icon-in-progress') && /Reading every guild/.test(text(coldHost.querySelector('.ob-main'))), coldHost && text(coldHost));
const cgo = async (label) => { [...coldHost.querySelectorAll('.ob-sections .sui-screen-nav-item')].find((a) => text(a) === label).click(); await until(() => coldHost.querySelector('.ob[data-page="' + (PAGE[label] || label.toLowerCase()) + '"]')); };
await cgo('Join');
check('Join still draws: it comes from the servers, not the crawl', coldHost && coldHost.querySelector('.ob-funnel .ob-row[data-step]'));
T.setParams(coldId, { page: 'onboarding', view: 'runs' });
await until(() => coldHost.querySelector('.ob-runs'));
check('Learn ▸ Runs still draws: they come from the servers', coldHost && coldHost.querySelector('.ob-runs .ob-row[data-session]'));
w.__HARNESS_OB_COLD__ = 'done';
await cgo('Learn');
T.refresh(coldId, true);
const settled = await until(() => /No tutorial sessions yet/.test(text(coldHost.querySelector('.ob-main'))) ? coldHost : null);
check('once the crawl finished empty-handed, the page says there is nothing', !!settled, coldHost && text(coldHost.querySelector('.ob-main')));
delete w.__HARNESS_OB_COLD__;

// ── A popped-out card: every chart door opens its own window ──
const solo = await JSDOM.fromFile(harness, {
  url: pathToFileURL(harness).href + '?view=terminal&card=onboarding-solo', runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true,
  beforeParse(win) { win.__HARNESS_LAYOUT__ = { version: 3, cards: [{ id: 'onboarding-solo', type: 'onboarding', params: { page: 'trends' }, w: 3 }] }; },
});
const sw = solo.window, sd = sw.document;
const soloHost = await until(() => sd.querySelector('#tm-grid .tm-card[data-card="onboarding-solo"] .ob-trends') ? sd.querySelector('#tm-grid .tm-card[data-card="onboarding-solo"]') : null, 10000);
check('a popped-out Telemetry card opens on the page it was saved on', !!soloHost);
if (soloHost) {
  const door = (k) => soloHost.querySelector('.ob-trends .ob-row[data-trend="' + k + '"] a.ob-link');
  door('humans').click();
  door('refiners_7d').click();
  door('humans').click();
  const opens = await until(() => { const c = (sw.__HARNESS_CALLS__ || []).filter((x) => x.cmd === 'open_terminal_card_new'); return c.length >= 3 ? c : null; });
  const metric = (c) => JSON.parse(c.args.params.series)[0].metric;
  check('…each chart door asks Rust for a chart window of its own series', opens && opens.every((c) => c.args.kind === 'chart' && c.args.params.window === '2592000') && opens.map(metric).join() === 'humans,refiners_7d,humans', opens && JSON.stringify(opens.map((c) => c.args)));
  check('…with params that differ by series, which is what Rust keys a re-focus on', opens && JSON.stringify(opens[0].args.params) !== JSON.stringify(opens[1].args.params) && JSON.stringify(opens[0].args.params) === JSON.stringify(opens[2].args.params));
  check('…and no card lands in the solo window itself', sd.querySelectorAll('#tm-grid .tm-card').length === 1);
}
solo.window.close();

// ── Wiring ──
check('the command is registered with Tauri', /onboarding::terminal_onboarding/.test(read('src-tauri/src/main.rs')));
check('every onboarding report sends include_excluded, and the caches key on it',
  (read('src-tauri/src/mcp/guild_api.rs').match(/include_excluded\(all\)/g) || []).length === 5 &&
  /type AggregateKey = \([^;]*bool\);/.test(read('src-tauri/src/mcp/onboarding.rs')) && /type RunsKey = \([^;]*bool\);/.test(read('src-tauri/src/mcp/onboarding.rs')));
check('and reachable from the web board, filters and all', /"terminal_onboarding"/.test(read('src-tauri/src/mcp/web_board.rs')) && /body\.get\("filters"\)/.test(read('src-tauri/src/mcp/web_board.rs')));
check('the desktop build reports its own interface, guarded against upstream drift',
  /ONBOARDING_INTERFACE_NAME = 'structs-desktop'/.test(read('scripts/apply-patches.sh')) && /verify_patched [^\n]*OnboardingTelemetry\.js/.test(read('scripts/apply-patches.sh')));
const refresh = read('src-tauri/src/mcp/onboarding_players.rs').split('pub async fn refresh_replicants')[1] || '';
check('replicants come from the chain first: the guild\'s list runs short', refresh.indexOf('read_replicants()') >= 0 && refresh.indexOf('read_replicants()') < refresh.indexOf('/api/permission/all'));
check('every outcome in the strip has a colour', ['completed', 'declined', 'left', 'playing'].every((k) => new RegExp('\\.ob-seg-' + k + ' \\{ background').test(read('frontend/onboarding.css'))));
check('every segment swatch has a colour', [0, 1, 2, 3, 4, 5].every((i) => new RegExp('\\.ob-sw-' + i + ' \\{ background').test(read('frontend/onboarding.css'))));
check('Rust opens a new chart window unless one with the same params exists', /want\.is_some\(\) \|\| bare \|\| c\.params == \*params/.test(read('src-tauri/src/mcp/terminal.rs')));
check('the Chart card can plot the daily record', /"source": "telemetry"/.test(read('src-tauri/src/mcp/charts.rs')) && /"telemetry" =>/.test(read('src-tauri/src/mcp/charts.rs')));
check('the record keeps going at launch for a player who has one', /resume_history_ticker\(\)/.test(read('src-tauri/src/game_state.rs')));
check('board.html loads the script and the sheet', /board-terminal-onboarding\.js/.test(read('frontend/board.html')) && /onboarding\.css/.test(read('frontend/board.html')));

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
