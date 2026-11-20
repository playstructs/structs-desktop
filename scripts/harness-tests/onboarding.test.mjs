// The Telemetry card (board-terminal-onboarding.js) against the static harness.
//
//   bash scripts/make_harness.sh && node scripts/harness-tests/onboarding.test.mjs
//
// The brief this pins (proposals/telemetry-redesign.md): eight sections in
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

const dom = await JSDOM.fromFile(harness, { url: pathToFileURL(harness).href + '?view=terminal', runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true });
const w = dom.window, d = w.document;
await until(() => w.Board && w.Board.Terminal && w.Board.Terminal.add && w.Board.Terminal.onboarding);
const T = w.Board.Terminal;

// ── ⌘K ──
check('TELEMETRY, ONBOARDING, FUNNEL and SIGNUPS open the card', ['TELEMETRY', 'ONBOARDING', 'FUNNEL', 'SIGNUPS'].every((x) => T.parse(x) && T.parse(x).type === 'onboarding'));
const row = T.suggestFor('').find((o) => /\bTELEMETRY\b/.test(String(o.words || '')));
check('filed under Explore as Telemetry', row && row.group === 'Explore' && row.what === 'Telemetry', JSON.stringify(row || null));
const pp = (line) => (T.parse(line) || {}).params;
check('a word opens a section: TELEMETRY retention lands on Engagement ▸ Retention', JSON.stringify(pp('TELEMETRY retention')) === '{"page":"engagement","view":"retention"}', JSON.stringify(pp('TELEMETRY retention')));
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
check('each section names the controls it reads', O.uses('trends', 'guild') && !O.uses('trends', 'reps') && !O.uses('acquisition', 'reps') && !O.uses('acquisition', 'activity') && O.uses('engagement', 'reps') && !O.uses('data', 'guild'));
check('a running server total sparks as its daily increase', JSON.stringify(O.sparkOf({ history_series: { series: { signups_started: [null, 5, 7, 7, 10] } } }, {}, 'h:signups_started', true)) === '[2,0,3]');
check('the daily record only sparks for the plain population', O.sparkOf({ history_series: { series: { mau: [1, 2, 3] } } }, {}, 'h:mau', false) === null);
check('percentages: whole above 10%, one decimal below, a dash for nothing', O.pct(0.364) === '36%' && O.pct(0.029) === '2.9%' && O.pct(null) === '—' && O.pct(1) === '100%');
check('the flagged steps are the largest, never a zero or a null', JSON.stringify(O.topKeys([{ key: 'a', d: 3 }, { key: 'b', d: null }, { key: 'c', d: 9 }, { key: 'e', d: 0 }], (r) => r.d, 3)) === '["c","a"]');
check('count buckets read as whole ranges, the last open', O.bucketLabel({ lo: 0, hi: 0 }, 'count') === '0' && O.bucketLabel({ lo: 10, hi: 100 }, 'count') === '10–99' && /^≥ /.test(O.bucketLabel({ lo: 1e5, hi: null }, 'count')));
check('refined alpha arrives in grams and is drawn on the alpha ladder', O.fmtKind('alpha', 2) === w.Board.helpers.fmtAlpha(2e6));
const args = O.argsOf({ iface: 'structs-webapp', activity: 'inactive', compare: 'guild', active: '30', idle: '72', page: 'guilds', win: '7' });
check('the card asks with its filters, never its page or window', args.filters.interface === 'structs-webapp' && args.filters.activity === 'inactive' && args.filters.compare === 'guild' && args.activeDays === 30 && args.idleHours === 72 && !('page' in args) && !('win' in args), JSON.stringify(args));
check('an unknown page or view falls back to the first', O.pageOf({ page: 'nope' }) === 'overview' && O.viewOf({ page: 'onboarding', view: 'nope' }) === 'phases' && O.viewOf({ page: 'guilds' }) === null);
const jr = O.journeyRows({ signup: { started: 100, signed_up: 50 }, tutorial: { offered: 40, completed: 10, steps: [{ key: 'tutorial.loading', reached: 30 }] }, activation: [{ key: 'signed_up', n: 50 }, { key: 'acted', n: 40 }, { key: 'raided', n: 4 }, { key: 'active', n: 20 }] });
const jk = jr.map((r) => r.part ? '|' + r.part : r.key).join(',');
check('the journey is three parts, never divided into each other', jk === '|signup,opened,signed,|tutorial,offered,started,finished,|game,signed_up,acted,raided,active', jk);
const jby = (k) => jr.find((r) => r.key === k);
check('…each part\'s first row converts from nothing, the rest from the row above', jby('opened').prev === null && jby('signed').prev === 0.5 && jby('offered').prev === null && jby('started').prev === 0.75 && jby('acted').prev === 0.8);
check('…and still-active is where players are, not a step after raiding', jby('active').prev === null && jby('active').first === 0.4);

const NOW = Date.UTC(2026, 10, 20), DAY = 86400000;
const wk = O.runWeeks([{ started_ms: NOW - DAY, outcome: 'completed', player_id: '1-1' }, { started_ms: NOW - 2 * DAY, outcome: 'left', player_id: null }, { started_ms: NOW - 9 * DAY, outcome: 'completed', player_id: '1-2' }], NOW, 3);
check('runs: this week against last week, from the run list', wk && wk[0].runs === 2 && wk[0].completed === 1 && wk[0].no_player === 1 && wk[1].runs === 1, JSON.stringify(wk));
check('…but not when the list does not reach back two weeks and holds fewer runs than there are', O.runWeeks(Array.from({ length: 100 }, (_, i) => ({ started_ms: NOW - i * 3600000, outcome: 'completed' })), NOW, 140) === null && O.runWeeks([{ started_ms: NOW - DAY }], NOW, 40) === null);
check('the copied word reads back as the same view', JSON.stringify(O.parseArgs(O.wordOf({ page: 'onboarding', view: 'runs', win: '7', guild: '0-5', compare: 'version', activity: 'active', reps: '1', iface: 'structs-desktop', version: 'tutorial-3' }).replace(/^TELEMETRY /, ''))) === '{"page":"onboarding","view":"runs","win":"7","guild":"0-5","compare":"version","activity":"active","reps":"1","iface":"structs-desktop","version":"tutorial-3"}');
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
    await until(() => host.querySelector('.ob[data-page="' + label.toLowerCase() + '"]'));
  };
  const kpiText = (k) => { const t = host.querySelector('.ob-tile[data-kpi="' + k + '"]'); return t && [...t.querySelectorAll('.ob-tile-stage, .ob-tile-scope, .ob-tile-label, .fstat-v, .ob-tile-sub, .ob-delta')].map(text).join(' ').toUpperCase(); };
  const sections = [...host.querySelectorAll('.ob-sections .sui-screen-nav-item')].map(text);
  check('eight sections in journey order', sections.join('|') === 'Overview|Acquisition|Onboarding|Engagement|Players|Guilds|Trends|Data', sections.join('|'));
  check('one read, asked with the default windows and no filter, humans only', calls().length >= 1 && calls()[0].args.idleHours === 24 && calls()[0].args.activeDays === 7 && !calls()[0].args.filters.compare && calls()[0].args.filters.replicants === false, JSON.stringify(calls()[0] || null));
  check('the scope bar: population, guild, interface, activity, version, split', [...host.querySelectorAll('.ob-scope [data-control]')].map((n) => n.dataset.control).join(',') === 'reps,guild,iface,activity,version,compare');

  // ── Overview ──
  const fg = (k) => host.querySelector('.ob-fg-row[data-funnel="' + k + '"]');
  const fgText = (k) => fg(k) && [...fg(k).querySelectorAll('.ob-fg-stage, .ob-fg-label, .ob-fg-value')].map(text).join(' ');
  check('OVERVIEW opens on the pirate funnel: four stages in the owner\'s words, top first', [...host.querySelectorAll('.ob-fg-row')].map((r) => r.dataset.funnel).join() === 'awareness,acquisition,activation,retention' && host.querySelector('.ob-view').firstElementChild.nextElementSibling.dataset.block === 'funnel' && fgText('awareness') === 'Awareness Started signup 2,140' && fgText('acquisition') === 'Acquisition Signups 9,600' && fgText('activation') === 'Activation Activated 768' && fgText('retention') === 'Retention Active users 115', ['awareness', 'acquisition', 'activation', 'retention'].map(fgText).join(' | '));
  check('…awareness is the people who started signing up, on its own scale since telemetry began', !fg('awareness').classList.contains('is-missing') && /since telemetry began/.test(text(fg('awareness'))) && fg('awareness').querySelector('.ob-fg-bar').style.width === '100%' && fg('acquisition').querySelector('.ob-fg-bar').style.width === '100%');
  const fgSteps = [...host.querySelectorAll('.ob-fg-step')].map(text);
  check('…each step says how many of the stage above made it', fgSteps.length === 3 && /^51\.0% finished signing up \(1,091 of 2,140\) ?Signups count every player, also those from before signups were recorded$/.test(fgSteps[0]) && fgSteps[1] === '8.0% of signups activated' && fgSteps[2] === '15.0% of activated are active users', fgSteps.join(' | '));
  check('…each stage is a part of the one above: bars only narrow', (() => { const w = ['acquisition', 'activation', 'retention'].map((k) => parseFloat(fg(k).querySelector('.ob-fg-bar').style.width)); return w[0] === 100 && w[1] < w[0] && w[2] < w[1]; })());
  check('…retention follows the window, and the funnel names it', /active this month/.test(text(host.querySelector('.ob-block[data-block="funnel"] .ob-chip'))) && O.funnelStages({ pirate: { all: { players: 10, activated: 4 }, windows: [{ days: 7, active_activated: 2 }] } }, '7')[3].value === 2);
  check('THE PERIOD: signups, activated and active users over the window, the same words as the funnel', [...host.querySelectorAll('.ob-tile')].map((t) => t.dataset.kpi).join() === 'new,activated,active_users' && /^ACQUISITION SIGNUPS 225/.test(kpiText('new')) && /^ACTIVATION ACTIVATED 40 20 OF THEM SIGNED UP IN THE WINDOW NO CHANGE VS PRIOR 30D · 40/.test(kpiText('activated')) && /^RETENTION ACTIVE USERS 115 15% OF ACTIVATED PLAYERS/.test(kpiText('active_users')), kpiText('new') + ' | ' + kpiText('activated') + ' | ' + kpiText('active_users'));
  check('…a windowed tile carries its change against the window before, coloured by direction', /\+62 · 38% VS PRIOR 30D/.test(kpiText('new')) && host.querySelector('.ob-tile[data-kpi="new"] .ob-delta.is-up') && host.querySelector('.ob-tile[data-kpi="activated"] .ob-delta.is-flat'), kpiText('new'));
  check('…both ends from one series, and only when that series reproduces the figure; otherwise it says the sources differ', O.deltaFor(288, [1, 1, 1, 1], 2, 'daily').mismatch && O.deltaFor(2, [1, 1, 1, 1], 2, 'daily').change === 0 && O.deltaOf([1, null, 1, 1], 2, 'daily') === null && O.shareOf(1, 5, 'signup opens') === '1 of 5 signup opens');
  const tsv = O.tsvOf(host.querySelector('.ob-kpi'));
  check('…and the strip copies as a report a sheet can use: value, previous, change, %, period and its dates', /^Figure\tValue\tPrevious\tChange\tChange %\tDetail\tPeriod\tDates\n/.test(tsv) && /\nSignups\t225\t163\t62\t38\.0%\t\t30 days\t\w{3} \d+–\w{3} \d+/.test(tsv), tsv.slice(0, 300));
  check('…and the strip states its window', !!host.querySelector('.ob-kpi-head .ob-windows .sui-mod-active') && text(host.querySelector('.ob-kpi-head .ob-windows .sui-mod-active')) === '30 days');
  const sig = [...host.querySelectorAll('.ob-signal')];
  check('SIGNALS: game findings first in player words, ranked by rate; the data\'s trouble one row at the end', sig.length >= 5 && /^Most signups stop at Recovery key create/.test(text(sig[0])) && /^Combat Training loses most at Offer/.test(text(sig[1])) && sig.at(-1).classList.contains('is-data') && /^2 data issues/.test(text(sig.at(-1))), sig.map(text).join(' | '));
  check('…a cohort is named by the day its week began, not an ISO week', sig.some((s) => /Joined week of Oct 12/.test(text(s))) && !sig.some((s) => /W4\d/.test(text(s))));
  check('…and no tutorial group is called best on twelve players', !sig.some((s) => /activate most/.test(text(s))));
  check('…signals copy too', /^Most signups stop at Recovery key create\t/.test(O.tsvOf(host.querySelector('.ob-block[data-block="signals"]'))));
  const aar = (label) => host.querySelector('.ob-aarrr .ob-row[data-aarrr="' + label + '"]');
  check('PIRATE METRICS BY WINDOW: the same four stages, every window', [...host.querySelectorAll('.ob-aarrr .ob-row[data-aarrr]')].map((r) => r.dataset.aarrr).join() === 'Started signup,Signups,Activated,Signups who activated,Active users,Anyone active' && text(aar('Started signup').children[5]) === '2,140' && text(aar('Signups').children[3]) === '54' && text(aar('Signups').children[5]) === '9,600', [...host.querySelectorAll('.ob-aarrr .ob-row[data-aarrr]')].map(text).join(' | '));
  check('…activation is refining AND raiding, with how many of the signups got there', /^768 ?8.0%$/.test(text(aar('Activated').children[5])) && /^20 ?8.9%$/.test(text(aar('Signups who activated').children[4])), text(aar('Activated')) + ' | ' + text(aar('Signups who activated')));
  check('…each stage name heads its group only once', text(aar('Activated').children[0]) === 'Activation' && text(aar('Signups who activated').children[0]) === '' && !aar('Referred players'));
  check('…rows with a series carry their line, and open as a chart', !!aar('Signups').querySelector('svg') && !aar('Active users').querySelector('svg') && aar('Signups').querySelector('a.ob-link').dataset.chart === 'new');
  const jrow = (k) => host.querySelector('.ob-journey-table .ob-row[data-journey="' + k + '"]');
  check('JOURNEY: signup sessions, Combat Training, then the game, each part with its size', [...host.querySelectorAll('.ob-journey-table .ob-row.is-part')].map(text).join('|') === 'Signup · sessions · 2,140|Combat Training · sample of new signups · 1,102|In game · players · 9,600' && text(jrow('opened').children[2]) === '2,140' && text(jrow('signed').children[3]) === '51%', [...host.querySelectorAll('.ob-journey-table .ob-row.is-part')].map(text).join('|'));
  check('…activation follows refining; a raid, a planet and being active are not steps after it', text(jrow('activated').children[3]) === '20%' && ['raided', 'planet', 'active'].every((k) => jrow(k).classList.contains('is-aside') && text(jrow(k).children[3]) === '—'), text(jrow('activated')) + ' | ' + text(jrow('raided')));
  check('…and every block states its scope', text(host.querySelector('.ob-block[data-block="journey"] .ob-chip')) === 'All time' && text(host.querySelector('.ob-block[data-block="signals"] .ob-chip')) === 'Now' && text(host.querySelector('.ob-block[data-block="stages"] .ob-chip')) === 'Every window' && /^All time · active this month$/.test(text(host.querySelector('.ob-block[data-block="funnel"] .ob-chip'))));
  const before = calls().length;
  host.querySelectorAll('.ob-kpi-head .ob-windows .sui-screen-nav-item')[1].click();
  await until(() => /SIGNUPS 54/.test(kpiText('new') || ''));
  check('the window is a param: 7 days redraws without asking again', /SIGNUPS 54/.test(kpiText('new')) && /active this week/.test(text(host.querySelector('.ob-block[data-block="funnel"] .ob-chip'))) && calls().length === before, kpiText('new'));
  check('…and the copied word reopens it', O.wordOf({ win: '7' }) === 'TELEMETRY 7d' && host.querySelector('.ob-act[data-act="word"]').title === 'TELEMETRY 7d');

  // ── Acquisition ──
  await go('Acquisition');
  check('sections switch from the last read, without asking again', calls().length === before);
  check('the card is titled by its section', /Telemetry · Acquisition/.test(text(d.querySelector('#tm-grid .tm-card[data-card="' + id + '"] .tm-title'))), text(d.querySelector('#tm-grid .tm-card[data-card="' + id + '"] .tm-title')));
  check('ACQUISITION: the same signup and new-player figures on the same window, then the all-time funnel figures', /STARTED SIGNUP 21/.test(kpiText('opens')) && /^ALL TIME NEVER FINISHED 1,049 49% OF 2,140 STARTS/.test(kpiText('dropoff')) && /SIGNUP TAKES 4 MIN/.test(kpiText('signup_time')) && /SIGNUPS 54/.test(kpiText('new')), kpiText('dropoff') + ' | ' + kpiText('signup_time'));
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
  check('ACQUISITION ignores replicants and activity: dimmed, not hidden', host.querySelector('.ob-scope [data-control="reps"]').classList.contains('is-off') && host.querySelector('.ob-scope [data-control="activity"]').disabled && !host.querySelector('.ob-scope [data-control="guild"]').disabled);

  // ── Onboarding ──
  await go('Onboarding');
  check('ONBOARDING: players, take-up, finished, skipped, quit, time', ['players', 'takeup', 'finished', 'skipped', 'quit', 'time'].every((k) => host.querySelector('.ob-tile[data-kpi="' + k + '"]')) && /^TAKE-UP 83%/.test(kpiText('takeup')), kpiText('takeup'));
  check('…views: phases, steps, runs, timing, by outcome — above the figures', [...host.querySelectorAll('.ob-subnav .sui-screen-nav-item')].map(text).join('|') === 'Phases|Steps|Runs|Timing|By outcome' && host.querySelector('.ob-subnav').compareDocumentPosition(host.querySelector('.ob-kpi')) & 4);
  check('PHASES: the outcome strip', host.querySelectorAll('.ob-stack .ob-seg').length === 4);
  const phaseRow = (l) => host.querySelector('.ob-phases .ob-row[data-phase="' + l + '"]');
  check('…a phase reads like every funnel: reached, kept, stopped, stop rate, skipped', phaseRow('Offer') && text(phaseRow('Offer').children[2]) === '1,102' && text(phaseRow('Offer').children[4]) === '215' && text(phaseRow('Offer').children[5]) === '19.5%' && phaseRow('Offer').children[5].classList.contains('is-bad') && text(phaseRow('Offer').children[6]) === '182', phaseRow('Offer') && text(phaseRow('Offer')));
  check('…a phase the design lacks is not drawn', !phaseRow('Free play') && !!phaseRow('First attack'));
  phaseRow('First attack').querySelector('a.ob-drill').click();
  const inner = host.querySelector('.ob-phases .ob-subtable');
  check('…a phase opens into its steps', inner && inner.querySelector('.ob-row[data-step="tutorial.first_attack.combat"]'));
  inner.querySelector('.ob-row[data-step="tutorial.first_attack.combat"] a.ob-drill').click();
  check('…and a step into the players who stopped there, with a door to all of them', /Kestrel/.test(text(host.querySelector('.ob-phases .ob-subtable .ob-who'))) && !!host.querySelector('.ob-phases .ob-who .ob-act[data-act="all_stopped"]'));
  host.querySelector('.ob-phases .ob-subtable .ob-row[data-step="tutorial.first_attack.combat"] a.ob-drill').click();
  phaseRow('First attack').querySelector('a.ob-drill').click();
  await go('Onboarding', 'Steps');
  check('STEPS lead with unique players', /Steps · 920 unique players/.test(text(host.querySelector('.ob-block[data-block="steps"] .ob-title'))));
  const combat = host.querySelector('.ob-steps .ob-row[data-step="tutorial.first_attack.combat"]');
  check('…a step with known leavers can be opened, one without cannot', combat && combat.querySelector('a.ob-drill') && !host.querySelector('.ob-steps .ob-row[data-step="tutorial.loading"] a.ob-drill'));
  combat.querySelector('a.ob-drill').click();
  const who = host.querySelector('.ob-steps .ob-who');
  check('…opening a step lists who stopped there, and says how many the servers did not list', who && who.querySelector('[data-player="1-9584"]') && /2 listed of 53 stopped/.test(text(who)), who && text(who));
  [...host.querySelectorAll('.ob-count .sui-screen-nav-item')].find((a) => text(a) === 'New signups').click();
  await until(() => host.querySelector('.ob-funnel'));
  const offer = host.querySelector('.ob-funnel .ob-row[data-step="orientation.tutorial_offer"]');
  check('…the new-signup sample, with skips per step', offer && text(offer.children[6]) === '182' && text(offer.children[7]) === '17%', offer && text(offer));
  check('…an opened step stays open across a redraw', !!host.querySelector('.ob-funnel .ob-who'));
  await go('Onboarding', 'Runs');
  check('RUNS: players, runs, finished, quit, no player', /^PLAYERS 31/.test(kpiText('run_players')) && /^RUNS 40 9 REPEAT/.test(kpiText('runs')) && /^FINISHED 24 60% OF RUNS/.test(kpiText('run_finished')) && /^NO PLAYER 2/.test(kpiText('no_player')), kpiText('runs'));
  const logged = host.querySelector('.ob-runs .ob-row[data-session="aaaa"]');
  check('…a run is listed by interface, kind, outcome and time', logged && /1-194/.test(text(logged.children[0])) && text(logged.children[2]) === 'Desktop app' && text(logged.children[5]) === 'Existing' && text(logged.children[6]) === 'Finished' && /10m/.test(text(logged.children[8])), logged && text(logged));
  const nameless = host.querySelector('.ob-runs .ob-row[data-session="cccc"]');
  check('…a run nobody is attached to says so and offers no player link', nameless && text(nameless.children[0]) === 'No player' && !nameless.querySelector('a'), nameless && text(nameless));
  const byRun = [...host.querySelectorAll('.ob-run-compare .ob-row[data-run]')];
  check('…first runs beside later ones', byRun.length === 2 && text(byRun[0].children[0]) === 'First run' && text(byRun[1].children[2]) === '6 of 10', byRun.map(text).join(' | '));
  await go('Onboarding', 'Timing');
  check('TIMING ranks steps by median time', host.querySelector('.ob-slow .ob-row[data-step]').dataset.step === 'signup.recovery_key_create' && host.querySelectorAll('.ob-durations .ob-row[data-metric]').length === 6);
  await go('Onboarding', 'By outcome');
  const grp = (k) => host.querySelector('.ob-impact .ob-row[data-group="' + k + '"]');
  check('BY OUTCOME: one row per tutorial outcome, then everyone; only a group of twenty or more can be marked best', ['finished', 'quit', 'skipped', 'none', 'all'].every((k) => grp(k)) && /^5 ?of 12$/.test(text(grp('finished').children[5])) && !grp('finished').querySelector('.is-best') && grp('none').children[5].classList.contains('is-best') && grp('finished').classList.contains('is-small'), grp('finished') && text(grp('finished')));

  // ── Engagement ──
  await go('Engagement');
  check('ENGAGEMENT: the same active and activated figures as Overview, then the all-time ones, each saying so', ['active', 'stickiness', 'activated', 'activated_ever', 'tta', 'never'].every((k) => host.querySelector('.ob-tile[data-kpi="' + k + '"]')) && /ACTIVE THIS WEEK 192/.test(kpiText('active')) && /^ALL TIME TIME TO ACTIVATE 3 DAYS/.test(kpiText('tta')), kpiText('active') + ' | ' + kpiText('tta'));
  check('…where players are now, on every view', ['today', 'week', 'month', 'gone', 'never'].every((k) => host.querySelector('.ob-key[data-life="' + k + '"]')));
  const miles = [...host.querySelectorAll('.ob-activation .ob-row[data-milestone]')];
  check('ACTIVATION: milestones from signing up to activated, with a raid, a planet and being active set aside', miles.map((r) => r.dataset.milestone).join() === 'signed_up,acted,mined,refined,raided,activated,planet,active' && /90%/.test(text(miles[1])) && /^Activated ?768/.test(text(miles[5])) && miles[4].classList.contains('is-aside') && /Active this week/.test(text(miles[7])), miles.map(text).join(' | '));
  await go('Engagement', 'Retention');
  const week = (k) => host.querySelector('.ob-cohort[data-week="2026-' + k + '"]');
  check('RETENTION: a cohort is a row of shaded weeks', week('W40') && text(week('W40').children[3]) === '50%' && week('W40').children[3].classList.contains('ob-heat-2'), week('W40') && text(week('W40')));
  check('…a small cohort shows quiet counts, an unlived week is blank, rows are named by date', text(week('W41').children[3]) === '3' && week('W41').children[3].classList.contains('ob-heat-count') && week('W41').children[5].classList.contains('ob-heat-none') && text(week('W40').children[0]) === 'Sep 28');
  check('…week one leaves out cohorts with nothing to show', !host.querySelector('.ob-week[data-week="W43"]') && /^3 of 12/.test(text(host.querySelector('.ob-week[data-week="W41"]'))));
  check('…churn apart from never acted, and the play length of the inactive', /Never acted/.test(text(host.querySelector('.ob-block[data-block="churn"]'))) && /Play length of inactive players after signup/.test(text(host.querySelector('.ob-view'))));
  await go('Engagement', 'Distributions');
  const blocks = [...host.querySelectorAll('.ob-block[data-block="dist"]')];
  check('DISTRIBUTIONS: five, each with its histogram', blocks.length === 5 && /Ore mined/.test(text(blocks[0])) && /Raids won/.test(text(blocks[4])) && blocks[0].querySelectorAll('.ob-hist .ob-row:not(.ob-head)').length === 7 && blocks[2].querySelectorAll('.ob-hist .ob-row:not(.ob-head)').length === 3, [...blocks].map((b) => b.querySelectorAll('.ob-hist .ob-row:not(.ob-head)').length).join());

  // ── Players ──
  await go('Players');
  const p = () => host.querySelector('.ob-recent .ob-row[data-player="1-9580"]');
  check('PLAYERS: new signups with outcome and time in the tutorial', p() && /Finished/.test(text(p())) && /13m/.test(text(p())), p() && text(p()));
  const dots = (pid) => host.querySelector('.ob-recent .ob-row[data-player="' + pid + '"]').querySelectorAll('.ob-dot');
  check('…a journey is a square per phase, filled to the last reached', dots('1-9584').length === 11 && dots('1-9584')[5].classList.contains('is-done') && dots('1-9584')[6].classList.contains('ob-badge-playing'));
  host.querySelector('.ob-pill[data-outcome="declined"]').click();
  check('…an outcome narrows the list', [...host.querySelectorAll('.ob-recent .ob-row[data-player]')].map((r) => r.dataset.player).join() === '1-9571');
  host.querySelector('.ob-pill[data-outcome="all"]').click();
  [...host.querySelectorAll('.ob-subnav .sui-screen-nav-item')].find((a) => text(a) === 'Stopped').click();
  await until(() => host.querySelector('.ob-stopped'));
  check('PLAYERS ▸ STOPPED: every named player, with the step they stopped at said once', host.querySelectorAll('.ob-stopped .ob-row[data-player]').length === 2 && text(host.querySelector('.ob-stopped .ob-row[data-player="1-9584"]').children[1]) === 'First attack · Combat');
  [...host.querySelectorAll('.ob-subnav .sui-screen-nav-item')].find((a) => text(a) === 'New signups').click();
  await until(() => host.querySelector('.ob-recent'));
  const q = host.querySelector('.ob-search input');
  q.value = 'kest'; q.dispatchEvent(new w.Event('input'));
  await until(() => host.querySelectorAll('.ob-recent .ob-row[data-player]').length === 1);
  check('…a name finds a player', [...host.querySelectorAll('.ob-recent .ob-row[data-player]')].map((r) => r.dataset.player).join() === '1-9584');
  host.querySelector('.ob-search input').value = ''; host.querySelector('.ob-search input').dispatchEvent(new w.Event('input'));
  await until(() => host.querySelectorAll('.ob-recent .ob-row[data-player]').length === 3);
  host.querySelector('.ob-recent .ob-sort[data-sort="player"]').click();
  check('…a caption sorts, the same way in every list', [...host.querySelectorAll('.ob-recent .ob-row[data-player]')].map((r) => r.dataset.player).join() === '1-9580,1-9584,1-9571', [...host.querySelectorAll('.ob-recent .ob-row[data-player]')].map((r) => r.dataset.player).join());

  // ── Guilds ──
  await go('Guilds');
  const g = [...host.querySelectorAll('.ob-guilds .ob-row[data-guild]')];
  const sn = g.find((r) => r.dataset.guild === '0-5');
  check('GUILDS: biggest first, with no guild as its own quiet row', g.map((r) => r.dataset.guild).join(',') === '0-5,0-1,0-2,none' && g.find((r) => r.dataset.guild === 'none').classList.contains('is-quiet') && text(g.find((r) => r.dataset.guild === 'none').children[2]) === '188', g.map((r) => r.dataset.guild).join(','));
  check('…signup and tutorial finish rates, with their counts; a guild with no API is a dash', /^52% ?1,101 of 2,136$/.test(text(sn.children[5])) && /^37% ?402 of 1,101$/.test(text(sn.children[6])) && text(g.find((r) => r.dataset.guild === '0-2').children[5]) === '—', sn && text(sn));
  check('…each reporting guild has a Focus door and a Stopped door', !!sn.querySelector('[data-act="focus"]') && !!sn.querySelector('[data-act="stopped"]') && !g.find((r) => r.dataset.guild === '0-2').querySelector('[data-act="stopped"]'));
  sn.querySelector('a.ob-drill').click();
  const more = () => host.querySelector('.ob-guilds .ob-more[data-more="0-5"]');
  check('…a row opens the rest, with the same drill', more() && /Runs ?37/.test(text(more())) && /3,810 \/ 3,810/.test(text(more())), more() && text(more()));
  host.querySelector('.ob-guilds .ob-row[data-guild="0-5"] a.ob-drill').click();
  check('…and closes again', !more());

  // ── Trends ──
  await go('Trends');
  const tr = (k) => host.querySelector('.ob-trends .ob-row[data-trend="' + k + '"]');
  check('TRENDS: each figure with its line, latest, a week and a month: a change signed, a count not', tr('humans') && tr('humans').querySelector('svg') && text(tr('humans').children[2]) === '478' && text(tr('humans').children[3]) === '+14' && text(tr('humans').children[4]) === '+60' && text(tr('new').children[3]) === '54' && /^Added/.test(tr('new').children[3].title), tr('humans') && text(tr('humans')) + ' | ' + text(tr('new')));
  check('…grouped by the stage they measure', [...host.querySelectorAll('.ob-trends .ob-row.is-part')].map(text).join('|') === 'Awareness|Acquisition|Onboarding|Activation|Retention|Population', [...host.querySelectorAll('.ob-trends .ob-row.is-part')].map(text).join('|'));
  check('…a server figure starts when the record does', tr('signed_up') && text(tr('signed_up').children[2]) === '119' && text(tr('signed_up').children[4]) === '—', tr('signed_up') && text(tr('signed_up')));
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
  check('TRENDS reads the guild alone: replicants are off', !host.querySelector('.ob-scope [data-control="guild"]').disabled && host.querySelector('.ob-scope [data-control="reps"]').classList.contains('is-off'));
  await go('Trends', 'Daily');
  check('DAILY: a row per sampled day, newest first', host.querySelectorAll('.ob-daily .ob-row[data-day]').length === 6);

  // ── Data ──
  await go('Data');
  const srcs = [...host.querySelectorAll('.ob-sources .ob-row[data-source]')];
  check('DATA: every source and what it holds', srcs.length === 8 && /7,667 confirmed · 1,500 suspected/.test(text(srcs[1])) && /from the guild/.test(text(srcs[1])), srcs.map(text).join(' | '));
  check('…a guild read per guild', host.querySelectorAll('.ob-guild-reads .ob-row[data-guild]').length === 3 && /3,810 \/ 3,810/.test(text(host.querySelector('.ob-guild-reads .ob-row[data-guild="0-5"]'))));
  const iss = [...host.querySelectorAll('.ob-issues .ob-issue')].map((r) => r.dataset.issue);
  check('…leads with what is wrong, worst first, and says when the sources disagree', iss.join('|') === 'Replicants read from the guild|Runs with no player|Guilds with no API|Sources disagree', iss.join('|'));
  const rec = (k) => host.querySelector('.ob-reconcile .ob-row[data-figure="' + k + '"]');
  check('…the chain and the daily record side by side, a disagreement marked', rec('Signups, 30 days') && /agree/.test(text(rec('Signups, 30 days'))) && /^Active this month ?576 ?149 ?-427$/.test(text(rec('Active this month'))), rec('Active this month') && text(rec('Active this month')));
  check('…lost beacons name the guild, with the count', /SN\.C/.test(text(host.querySelector('.ob-issue[data-issue="Runs with no player"]'))) && /2 of 40 runs/.test(text(host.querySelector('.ob-issue[data-issue="Runs with no player"]'))));
  check('the status link counts issues, not notices, and opens Data', /^2 issues/.test(text(host.querySelector('.ob-status'))), text(host.querySelector('.ob-status')));
  check('…coverage counts players, split by why they are unseen', /In reporting guilds ?9,340/.test(text(host.querySelector('.ob-key[data-coverage="ok"]'))) && /In guilds with no API ?72/.test(text(host.querySelector('.ob-key[data-coverage="dark"]'))) && /In no guild ?188/.test(text(host.querySelector('.ob-key[data-coverage="none"]'))));
  check('…an issue is a door, with what fixes it on hover', host.querySelector('.ob-issue[data-issue="Runs with no player"]').tagName === 'A' && /launch message was lost/.test(host.querySelector('.ob-issue[data-issue="Runs with no player"]').title));
  check('…every definition, listed once', host.querySelectorAll('.ob-defs .ob-row[data-term]').length >= 15);
  check('…the footer counts humans and names the replicants set aside', /of 445 humans/.test(text(host.querySelector('.ob-foot'))) && /9,167 replicants under 9 primaries/.test(text(host.querySelector('.ob-foot'))), text(host.querySelector('.ob-foot')));
  const sel = (k) => host.querySelector('[data-control="' + k + '"]');
  sel('active').value = '30'; sel('active').dispatchEvent(new w.Event('change'));
  check('SETTINGS: the active window is a param and re-reads', !!(await until(() => calls().find((c) => c.args.activeDays === 30))));
  await until(() => sel('idle'));
  sel('idle').value = '72'; sel('idle').dispatchEvent(new w.Event('change'));
  check('…and so is the quit window', !!(await until(() => calls().find((c) => c.args.idleHours === 72))));
  await until(() => host.querySelector('.ob-ex-switch input'));
  const exSw = () => host.querySelector('.ob-ex-switch input');
  check('…excluded players are left out unless asked for', exSw() && !exSw().checked && calls().at(-1).args.filters.include_excluded === false);
  exSw().checked = true; exSw().dispatchEvent(new w.Event('change'));
  check('…the switch re-reads with everyone', !!(await until(() => calls().find((c) => c.args.filters.include_excluded === true))));
  await until(() => exSw() && exSw().checked);
  check('…and every page then says excluded players are in, beside the non-default windows', /excluded in · active 30d · quit 3d/.test(text(host.querySelector('.ob-status'))), text(host.querySelector('.ob-status')));
  exSw().checked = false; exSw().dispatchEvent(new w.Event('change'));
  await until(() => calls().at(-1).args.filters.include_excluded === false && exSw() && !exSw().checked);

  // ── Split ──
  const split = async (v) => { sel('compare').value = v; sel('compare').dispatchEvent(new w.Event('change')); await until(() => calls().find((c) => c.args.filters.compare === (v || null)) && (!v || host.querySelector('.ob-seglabel'))); };
  await go('Overview');
  await split('activity');
  check('a split is a param, re-reads, and marks the scope bar', calls().at(-1).args.filters.compare === 'activity' && sel('compare').classList.contains('is-set') && !!host.querySelector('.ob-reset'));
  await until(() => host.querySelector('.ob-kpi-table'));
  const head = [...host.querySelectorAll('.ob-kpi-table .ob-head .ob-c')].map(text);
  check('OVERVIEW splits the KPI strip into one column per segment, each with its swatch', head.join('|') === '|Active|Inactive|Sum' && host.querySelectorAll('.ob-kpi-table .ob-head .ob-swatch').length === 2, head.join('|'));
  check('…the funnel says when a group has no signup record', [...host.querySelectorAll('.ob-fg-row[data-funnel="awareness"]')].every((r) => r.classList.contains('is-missing')) && /not measurable for this group/.test(text(host.querySelector('.ob-fg-step'))));
  check('…signals name the segment they are about', [...host.querySelectorAll('.ob-signal')].some((s) => /· Active$/.test(text(s.querySelector('.ob-step').firstChild))));
  check('…a split\'s KPI rows keep their names', [...host.querySelectorAll('.ob-kpi-table .ob-row[data-kpi]')].map((r) => text(r.children[0])).join('|') === 'Signups|Activated|Active users', [...host.querySelectorAll('.ob-kpi-table .ob-row[data-kpi]')].map((r) => text(r.children[0])).join('|'));
  await go('Acquisition');
  check('…signup cannot be split by activity, and says so', /only known once signup finishes/.test(text(host.querySelector('.ob-view'))));
  await go('Engagement', 'Distributions');
  check('…distributions get a row per segment', [...host.querySelectorAll('.ob-dist .ob-row[data-seg]')].slice(0, 2).map((r) => r.dataset.seg).join(',') === 'active,inactive');
  await split('guild');
  await go('Onboarding', 'Steps');
  const th = text(host.querySelector('.ob-funnel-compare .ob-head'));
  check('ONBOARDING splits kept and stop rate per guild, with the signed difference', /OH · Kept/.test(th) && /SN\.C · Stop rate/.test(th) && /Δ stop rate OH − SN\.C/.test(th), th);
  await go('Onboarding', 'Phases');
  check('…and the phases split the same way', !!host.querySelector('.ob-block[data-block="phases"] .ob-funnel-compare .ob-row[data-step="phase:2"]'));
  await go('Onboarding', 'Runs');
  check('RUNS split: the KPI table has a column per guild', /OH/.test(text(host.querySelector('.ob-kpi-table .ob-head'))) && host.querySelectorAll('.ob-kpi-table .ob-row[data-kpi]').length === 5);
  await split('replicant');
  check('splitting by replicant locks the population to both', sel('reps').disabled && sel('reps').value === '1');
  await go('Acquisition');
  check('…replicants have no signup funnel, so Acquisition shows the humans alone', host.querySelector('.ob-view .ob-funnel') && !host.querySelector('.ob-view .ob-compare'));
  await split('tutorial');
  check('split by tutorial outcome, signup names why it has nothing', /The tutorial comes after signup/.test(text(host.querySelector('.ob-view'))));
  host.querySelector('.ob-reset').click();
  await until(() => !calls().at(-1).args.filters.compare && !host.querySelector('.ob-reset'));
  await go('Guilds');
  host.querySelector('.ob-guilds .ob-row[data-guild="0-5"] [data-act="stopped"]').click();
  await until(() => calls().find((c) => c.args.filters.guild === '0-5') && host.querySelector('.ob-stopped'));
  check('a guild\'s Stopped door opens its stopped players, and only theirs', [...host.querySelectorAll('.ob-stopped .ob-row[data-player]')].map((r) => r.dataset.player).join() === '1-9584' && /SN\.C/.test(text(host.querySelector('.ob-block[data-block="players"] .ob-chip.is-set'))));
  check('…and the card title names the guild', /Telemetry · Players · 0-5/.test(text(d.querySelector('#tm-grid .tm-card[data-card="' + id + '"] .tm-title'))));
  host.querySelector('.ob-reset').click();
  await until(() => !calls().at(-1).args.filters.compare && !host.querySelector('.ob-reset'));
  check('Reset clears every filter and the split', !calls().at(-1).args.filters.compare && !host.querySelector('.ob-reset'));
  sel('reps').value = '1'; sel('reps').dispatchEvent(new w.Event('change'));
  check('the population is a param: humans + replicants', !!(await until(() => calls().find((c) => c.args.filters.replicants === true))));
  await go('Data');
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
const cgo = async (label) => { [...coldHost.querySelectorAll('.ob-sections .sui-screen-nav-item')].find((a) => text(a) === label).click(); await until(() => coldHost.querySelector('.ob[data-page="' + label.toLowerCase() + '"]')); };
await cgo('Acquisition');
check('Acquisition still draws: it comes from the servers, not the crawl', coldHost && coldHost.querySelector('.ob-funnel .ob-row[data-step]'));
await cgo('Players');
[...coldHost.querySelectorAll('.ob-subnav .sui-screen-nav-item')].find((a) => text(a) === 'Tutorial runs').click();
await until(() => coldHost.querySelector('.ob-runs'));
check('Players ▸ runs still draws: they come from the servers', coldHost && coldHost.querySelector('.ob-runs .ob-row[data-session]'));
w.__HARNESS_OB_COLD__ = 'done';
await cgo('Onboarding');
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
