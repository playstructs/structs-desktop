// The Telemetry card (board-terminal-onboarding.js) against the static harness.
//
//   bash scripts/make_harness.sh && node scripts/harness-tests/onboarding.test.mjs
//
// The brief this pins: how far new players get through signup and Combat
// Training, how long it takes, where they quit or skip, and what players do
// afterwards — over every guild. Every page reads the same filters
// (interface, guild, active/inactive, replicants) and can compare by one of them.
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

// ── Pure pieces ──
const O = T.onboarding;
check('a step belongs to its phase; loading is the offer\'s', O.phaseOf('tutorial.first_attack.combat') === 6 && O.phaseOf('tutorial.loading') === 1 && O.phaseOf('signup.submit') === 0 && O.phaseOf('nothing') === -1);
const ph = O.phaseRows({ sessions: 10, durations: { signup: { p50: 120 } }, dwell: { 'tutorial.intro.welcome': { p50: 30 } }, tutorial: { steps: [{ key: 'orientation.tutorial_offer', reached: 9, skipped: 3 }, { key: 'tutorial.intro.welcome', reached: 5 }, { key: 'tutorial.end.ftl_jump', reached: 4 }] } });
check('phases: signed up leads, a skip is told from a stop, the last phase keeps its own', ph.map((r) => r.label).join() === 'Signed up,Offer,Intro,End' && ph[0].stopped === 1 && ph[1].skipped === 3 && ph[1].stopped === 1 && ph[2].time === 30 && ph[3].left === 4 && ph[3].stopped === 0, JSON.stringify(ph));
check('a cohort shades by share', [0, 0.1, 0.4, 0.8, 0.95].map(O.heatBand).join() === '0,1,2,3,4');
check('a step key reads as words, without its phase', O.stepLabel('tutorial.first_attack.choose_rail_gun') === 'First attack · Choose rail gun' && O.stepLabel('signup.recovery_key_create') === 'Recovery key create');
check('a share is a percentage only once there are enough to say so', O.share(402, 1102) === '36%' && O.share(3, 10) === '3 of 10' && O.share(0, 0) === '—');
check('outcomes lead with the servers\' unique players, else the sample', O.tutorialOf({ tutorial_players: { players: 9, completed: 4, left_at_offer: 1, left_during_tutorial: 2 }, tutorial: { offered: 3 } }).left === 3 && O.tutorialOf({ tutorial_players: null, tutorial: { offered: 3 } }).offered === 3 && !O.tutorialOf({ tutorial: {} }).unique);
check('a trend change needs a row that far back', O.trendChange([{ humans: 1 }, { humans: 4 }], 'humans', null, 1) === 3 && O.trendChange([{ humans: 1 }], 'humans', null, 7) === null);
check('percentages: whole above 10%, one decimal below, a dash for nothing', O.pct(0.364) === '36%' && O.pct(0.029) === '2.9%' && O.pct(null) === '—' && O.pct(1) === '100%');
check('the flagged steps are the largest, never a zero or a null', JSON.stringify(O.topKeys([{ key: 'a', d: 3 }, { key: 'b', d: null }, { key: 'c', d: 9 }, { key: 'e', d: 0 }], (r) => r.d, 3)) === '["c","a"]');
check('count buckets read as whole ranges, the last open', O.bucketLabel({ lo: 0, hi: 0 }, 'count') === '0' && O.bucketLabel({ lo: 10, hi: 100 }, 'count') === '10–99' && /^≥ /.test(O.bucketLabel({ lo: 1e5, hi: null }, 'count')));
check('refined alpha arrives in grams and is drawn on the alpha ladder', O.fmtKind('alpha', 2) === w.Board.helpers.fmtAlpha(2e6));
const args = O.argsOf({ iface: 'structs-webapp', activity: 'inactive', compare: 'guild', active: '30', idle: '72' });
check('the card asks with its filters', args.filters.interface === 'structs-webapp' && args.filters.activity === 'inactive' && args.filters.compare === 'guild' && args.activeDays === 30 && args.idleHours === 72, JSON.stringify(args));

// ── The card ──
const calls = () => (w.__HARNESS_CALLS__ || []).filter((c) => c.cmd === 'terminal_onboarding');
const card = T.add('onboarding', {}, 3);
const id = (card && card.id) || 'onboarding-1';
const host = await until(() => {
  const c = d.querySelector('#tm-grid .tm-card[data-card="' + id + '"] .tm-body');
  return c && c.querySelector('.ob-hud') ? c : null;
});
check('the card renders its readouts', host !== null);
if (host) {
  const tiles = [...host.querySelectorAll('.ob-hud .ob-tile')].map((t) => [...t.children].map(text).join(' ').toUpperCase());
  check('OVERVIEW: new, today, the window, and today against the month', /^120 NEW THIS WEEK JOINED$/.test(tiles[0]) && /^960 ACTIVE TODAY 10% OF 9,600$/.test(tiles[1]) && /^4,032 ACTIVE 7D 42% OF 9,600$/.test(tiles[2]) && /^16% TODAY \/ MONTH 960 OF 5,952$/.test(tiles[3]), JSON.stringify(tiles));
  const titles = [...host.querySelectorAll('.ob-view .ob-title')].map(text);
  check('OVERVIEW answers where players are, how far they got, and whether they stayed', titles.join('|') === 'Where players are now|Activation|New player path|Still acting after 1 week', titles.join('|'));
  check('OVERVIEW: the lifecycle buckets are all there', ['today', 'week', 'month', 'gone', 'never'].every((k) => host.querySelector('.ob-key[data-life="' + k + '"]')));
  check('OVERVIEW: the path runs from signup to finished', text(host.querySelector('.ob-path .ob-row[data-path="Started signup"]')).endsWith('2,140') && text(host.querySelector('.ob-path .ob-row[data-path="Finished"]')).endsWith('402'));
  check('OVERVIEW: week one leaves out cohorts with nothing to show, and a small one is a count', !host.querySelector('.ob-week[data-week="W43"]') && /^3 of 12/.test(text(host.querySelector('.ob-week[data-week="W41"]'))) && /^50%/.test(text(host.querySelector('.ob-week[data-week="W40"]'))));
  check('pages are grouped in a rail, with the status beside the filters', [...host.querySelectorAll('.ob-rail-head')].map(text).join('|') === 'Growth|Onboarding|Players|Network' && host.querySelectorAll('.ob-rail .sui-screen-nav-item').length === 12);
  check('one read, asked with the default windows and no filter', calls().length >= 1 && calls()[0].args.idleHours === 24 && calls()[0].args.activeDays === 7 && !calls()[0].args.filters.compare, JSON.stringify(calls()[0] || null));
  check('humans only by default', calls()[0].args.filters.replicants === false, JSON.stringify(calls()[0].args.filters));
  check('four filter controls, the windows, and the version', host.querySelectorAll('.ob-controls select').length === 7);

  const go = (label) => { [...host.querySelectorAll('.ob .sui-screen-nav-item')].find((a) => text(a) === label).click(); };
  const before = calls().length;
  go('Signup');
  const steps = [...host.querySelectorAll('.ob-funnel .ob-row[data-step]')];
  check('SIGNUP lists every step', steps.some((r) => r.dataset.step === 'signup.connecting') && steps.some((r) => r.dataset.step === 'signup.employee_record'), steps.length);
  const create = host.querySelector('.ob-funnel .ob-row[data-step="signup.recovery_key_create"]');
  check('the step most players quit at is flagged, by count and by rate', create && create.querySelectorAll('.is-bad').length === 2, create && text(create));
  check('drop-off individually and cumulatively', create && /\b16%/.test(text(create.children[6])) && /%$/.test(text(create.children[4])), create && text(create));
  const last = host.querySelector('.ob-funnel .ob-row[data-step="signup.employee_record"]');
  check('a last step has no quit figure, a dash and not a zero', last && text(last.children[5]) === '—', last && text(last.children[5]));
  check('views switch from the last read, without asking again', calls().length === before);

  go('Tutorial');
  check('TUTORIAL has the outcome strip', host.querySelectorAll('.ob-stack .ob-seg').length === 4);
  const tt = [...host.querySelectorAll('.ob-view .ob-title')].map(text);
  check('TUTORIAL leads with phases, then unique players, then the sample', /^Phases · /.test(tt[0]) && /^Unique players · 920$/.test(tt[1]) && host.querySelectorAll('.ob-steps .ob-row[data-step]').length > 5 && [...host.querySelectorAll('.ob-title')].some((t) => /^New signups · sample of 1,102$/.test(text(t))));
  const phaseRow = (n) => host.querySelector('.ob-phases .ob-row[data-phase="' + n + '"]');
  check('TUTORIAL: a phase shows who is left, what it lost and how long it took', phaseRow('Offer') && text(phaseRow('Offer').children[2]) === '705' && text(phaseRow('Offer').children[3]) === '-397' && phaseRow('Offer').children[3].classList.contains('is-bad'), phaseRow('Offer') && text(phaseRow('Offer')));
  check('…a skip is not a stop', phaseRow('Offer').querySelector('.ob-skip').style.width !== '0%' && phaseRow('Offer').querySelector('.ob-stop').style.width !== '0%');
  check('…a phase the design lacks is not drawn', !phaseRow('Free play') && !!phaseRow('First attack'));
  phaseRow('First attack').querySelector('a.ob-link').click();
  check('…and a phase that lost players opens them', /Kestrel/.test(text(host.querySelector('.ob-phases .ob-who'))));
  phaseRow('First attack').querySelector('a.ob-link').click();
  const combat = host.querySelector('.ob-steps .ob-row[data-step="tutorial.first_attack.combat"]');
  check('a step with known leavers can be opened, one without cannot', combat && combat.querySelector('a.ob-link') && !host.querySelector('.ob-steps .ob-row[data-step="tutorial.loading"] a.ob-link'));
  combat.querySelector('a.ob-link').click();
  const who = host.querySelector('.ob-steps .ob-who');
  check('opening a step lists who stopped there, and how many more', who && who.querySelector('[data-player="1-9584"]') && /Kestrel/.test(text(who)) && /51 more/.test(text(who)), who && text(who));
  check('…each name a door to the player', who && who.querySelector('[data-player="1-9560"] a.ob-link') && /1-9560/.test(text(who.querySelector('[data-player="1-9560"]'))));
  go('Overview'); go('Tutorial');
  check('an opened step stays open across a redraw', !!host.querySelector('.ob-steps .ob-who'));
  host.querySelector('.ob-steps .ob-row[data-step="tutorial.first_attack.combat"] a.ob-link').click();
  check('…and closes again', !host.querySelector('.ob-steps .ob-who'));
  const offer = host.querySelector('.ob-funnel-skips .ob-row[data-step="orientation.tutorial_offer"]');
  check('TUTORIAL: skips per step and so far', offer && text(offer.children[7]) === '182' && text(offer.children[8]) === '17%' && text(offer.children[9]) === '17%', offer && text(offer));

  go('Runs');
  const runTiles = [...host.querySelectorAll('.ob-hud .ob-tile')].map((t) => [...t.children].map(text).join(' ').toUpperCase());
  check('RUNS leads on players, then runs and repeats', /^31 PLAYERS$/.test(runTiles[0]) && /^40 RUNS 9 REPEAT$/.test(runTiles[1]), JSON.stringify(runTiles));
  check('RUNS: finished as a share of runs, and the runs with no player', runTiles.some((t) => /^24 FINISHED 60%$/.test(t)) && runTiles.some((t) => /^2 NO PLAYER$/.test(t)), JSON.stringify(runTiles));
  const logged = host.querySelector('.ob-runs .ob-row[data-session="aaaa"]');
  check('a long-standing player\'s run is listed by interface, kind, outcome and time', logged && /1-194/.test(text(logged.children[0])) && text(logged.children[2]) === 'structs-desktop' && text(logged.children[5]) === 'Existing' && text(logged.children[6]) === 'Finished' && /10m/.test(text(logged.children[8])), logged && text(logged));
  check('a player with no name shows the id once', logged && text(logged.children[0]) === '1-194', logged && text(logged.children[0]));
  const replay = host.querySelector('.ob-runs .ob-row[data-session="bbbb"]');
  check('a replay reads as one, with its run number', replay && text(replay.children[5]) === 'Replay' && text(replay.children[4]) === '2', replay && text(replay));
  const nameless = host.querySelector('.ob-runs .ob-row[data-session="cccc"]');
  check('a run nobody is attached to says so and offers no player link', nameless && text(nameless.children[0]) === 'No player' && !nameless.querySelector('a') && text(nameless.children[5]) === '—', nameless && text(nameless));

  go('Runs');
  const byRun = [...host.querySelectorAll('.ob-run-compare .ob-row[data-run]')];
  check('RUNS compares first runs with later ones', byRun.length === 2 && text(byRun[1].children[0]) === '2' && text(byRun[1].children[2]) === '6 of 10' && /^(25h|1d)/.test(text(byRun[1].children[5])), byRun.map(text).join(' | '));

  go('Players');
  const blocks = [...host.querySelectorAll('.ob-view .ob-block')];
  check('PLAYERS: five distributions', blocks.length === 5 && /Ore mined/.test(text(blocks[0])) && /Raids won/.test(text(blocks[4])), blocks.map((b) => text(b.firstChild)).join(' | '));
  check('a distribution has its histogram', blocks[0] && blocks[0].querySelectorAll('.ob-hist .ob-row').length === 10);

  go('Retention');
  const miles = [...host.querySelectorAll('.ob-activation .ob-row[data-milestone]')];
  check('RETENTION: activation from signup to still active', miles.length === 7 && /Acted/.test(text(miles[1])) && /90%/.test(text(miles[1])) && /Active 7d/.test(text(miles[6])), miles.map(text).join(' | '));
  const week = (k) => host.querySelector('.ob-cohort[data-week="2026-' + k + '"]');
  check('RETENTION: a cohort is a row of shaded weeks', week('W40') && text(week('W40').children[3]) === '50%' && week('W40').children[3].classList.contains('ob-heat-2') && text(week('W40').children[1]) === '400', week('W40') && text(week('W40')));
  check('RETENTION: a small cohort shows counts, an unlived week is blank', text(week('W41').children[3]) === '3' && text(week('W41').children[5]) === '' && week('W41').children[5].classList.contains('ob-heat-none'), week('W41') && text(week('W41')));
  check('RETENTION: never acted is apart from churn', /Never acted/.test(text(host.querySelector('.ob-view'))));
  check('RETENTION: churn and the play length of inactive players', /Churn/.test(text(host.querySelector('.ob-view'))) && /Play length of inactive players after signup/.test(text(host.querySelector('.ob-view'))));

  go('Timing');
  check('TIMING ranks steps by median time', host.querySelector('.ob-slow .ob-row[data-step]').dataset.step === 'signup.recovery_key_create');
  go('Trends');
  const tr = (k) => host.querySelector('.ob-trends .ob-row[data-trend="' + k + '"]');
  check('TRENDS: each figure with its line, now, a week and a month', tr('humans') && tr('humans').querySelector('svg') && text(tr('humans').children[2]) === '478' && text(tr('humans').children[3]) === '+14' && text(tr('humans').children[4]) === '+60', tr('humans') && text(tr('humans')));
  check('TRENDS: a server figure starts when the record does', tr('signed_up') && text(tr('signed_up').children[2]) === '119' && text(tr('signed_up').children[4]) === '—', tr('signed_up') && text(tr('signed_up')));
  const cards = () => d.querySelectorAll('#tm-grid .tm-card[data-type="chart"]').length;
  const beforeCharts = cards();
  tr('humans').querySelector('a.ob-link').click();
  check('TRENDS: a figure opens as a chart', !!(await until(() => cards() > beforeCharts)));

  go('Health');
  const srcs = [...host.querySelectorAll('.ob-sources .ob-src[data-source]')];
  check('HEALTH: every source and what it holds', srcs.length === 8 && /7,667 granted · 1,500 likely/.test(text(srcs[1])) && /guild/.test(text(srcs[1])), srcs.map(text).join(' | '));
  const iss = [...host.querySelectorAll('.ob-issues .ob-issue')].map((r) => r.dataset.issue);
  check('HEALTH leads with what is wrong, worst first', iss.join('|') === 'Replicants read from the guild|Runs with no player|Guilds with no API', iss.join('|'));
  check('…a guild-sourced replicant list is an issue: it undercounts them', host.querySelector('.ob-issue[data-issue="Replicants read from the guild"]').classList.contains('is-issue'));
  check('…lost beacons name the guild, with the count', /SN\.C/.test(text(host.querySelector('.ob-issue[data-issue="Runs with no player"]'))) && /2 of 40 runs/.test(text(host.querySelector('.ob-issue[data-issue="Runs with no player"]'))), text(host.querySelector('.ob-issue[data-issue="Runs with no player"]')));
  check('…a guild with no API is a notice', host.querySelector('.ob-issue[data-issue="Guilds with no API"]').classList.contains('is-notice') && /72 players/.test(text(host.querySelector('.ob-issue[data-issue="Guilds with no API"]'))));
  check('the status link counts issues, not notices', /^2 issues/.test(text(host.querySelector('.ob-status'))), text(host.querySelector('.ob-status')));
  check('HEALTH: coverage adds up to the players', /Reporting guilds ?9,340/.test(text(host.querySelector('.ob-key[data-coverage="ok"]'))) && /No API ?72/.test(text(host.querySelector('.ob-key[data-coverage="dark"]'))) && /No guild ?188/.test(text(host.querySelector('.ob-key[data-coverage="none"]'))));

  go('Guilds');
  const g = [...host.querySelectorAll('.ob-guilds .ob-row[data-guild]')];
  const sn = g.find((r) => r.dataset.guild === '0-5');
  check('GUILDS: biggest first, with no guild as its own quiet row', g.map((r) => r.dataset.guild).join(',') === '0-5,0-1,0-2,none' && g.find((r) => r.dataset.guild === 'none').classList.contains('is-quiet') && text(g.find((r) => r.dataset.guild === 'none').children[2]) === '188', g.map((r) => r.dataset.guild + ' ' + text(r)).join(' | '));
  check('GUILDS: signups read as a share, a guild with no API as a dash', text(sn.children[4]) === '1,101 of 2,136' && text(g.find((r) => r.dataset.guild === '0-2').children[4]) === '—' && /No API/.test(text(g.find((r) => r.dataset.guild === '0-2').children[0])), sn && text(sn));
  sn.querySelector('a.ob-link').click();
  const more = () => host.querySelector('.ob-guilds .ob-more[data-more="0-5"]');
  check('GUILDS: a row opens the rest, replicants not counted as sessions left to read', more() && /Runs ?37/.test(text(more())) && /3,810 \/ 3,810/.test(text(more())), more() && text(more()));
  sn.querySelector('a.ob-link').click();
  check('…and closes again', !more());
  g.find((r) => r.dataset.guild === '0-2').querySelector('a.ob-link').click();
  check('…a guild with no API says why', /no guild API published/.test(text(host.querySelector('.ob-more[data-more="0-2"]'))));
  g.find((r) => r.dataset.guild === '0-2').querySelector('a.ob-link').click();
  go('Recent');
  const p = host.querySelector('.ob-recent .ob-row[data-player="1-9580"]');
  check('RECENT shows outcome and time in the tutorial', p && /Finished/.test(text(p)) && /13m/.test(text(p)), text(p));
  const dots = (id) => host.querySelector('.ob-recent .ob-row[data-player="' + id + '"]').querySelectorAll('.ob-dot');
  check('RECENT: a journey is a square per phase, filled to the last reached', dots('1-9584').length === 11 && dots('1-9584')[5].classList.contains('is-done') && dots('1-9584')[6].classList.contains('ob-badge-playing') && !dots('1-9584')[7].classList.contains('is-done'));
  host.querySelector('.ob-pill[data-outcome="declined"]').click();
  check('RECENT: an outcome narrows the list', [...host.querySelectorAll('.ob-recent .ob-row[data-player]')].map((r) => r.dataset.player).join() === '1-9571');
  host.querySelector('.ob-pill[data-outcome="all"]').click();
  check('…and All brings it back', host.querySelectorAll('.ob-recent .ob-row[data-player]').length === 3);

  // ── Compare ──
  const sel = () => [...host.querySelectorAll('.ob-controls select')];
  sel()[3].value = 'activity'; sel()[3].dispatchEvent(new w.Event('change'));
  const asked = await until(() => calls().find((c) => c.args.filters.compare === 'activity'));
  check('Compare is a param and re-reads', !!asked);
  await until(() => host.querySelector('.ob-compare'));
  go('Overview');
  const head = [...host.querySelectorAll('.ob-compare .ob-head .ob-c')].map(text);
  check('OVERVIEW compares one column per segment', head.join('|') === '|Active|Inactive', head.join('|'));
  go('Signup');
  check('signup cannot be split by activity, and says so', /only known once signup finishes/.test(text(host.querySelector('.ob-view'))));
  go('Players');
  const segRows = [...host.querySelectorAll('.ob-dist .ob-row[data-seg]')].map((r) => r.dataset.seg);
  check('PLAYERS compares a row per segment', segRows.slice(0, 2).join(',') === 'active,inactive', segRows.join(','));

  sel()[3].value = 'guild'; sel()[3].dispatchEvent(new w.Event('change'));
  await until(() => calls().find((c) => c.args.filters.compare === 'guild'));
  await until(() => /OH/.test(text(host.querySelector('.ob-dist'))));
  go('Tutorial');
  const th = text(host.querySelectorAll('.ob-compare')[1].querySelector('.ob-head'));
  check('TUTORIAL compares kept, drop and skip per guild', /OH · Kept/.test(th) && /SN\.C · Kept/.test(th) && /Skip/.test(th), th);

  go('Runs');
  const rc = [...host.querySelectorAll('.ob-compare .ob-row[data-metric]')].map((r) => r.dataset.metric);
  check('RUNS compares a column per segment, on the same figures', rc.join(',') === 'runs,players,completed,left,playing,repeat,replays,existing,no_player' && /OH/.test(text(host.querySelector('.ob-compare .ob-head'))), rc.join(','));

  sel()[0].value = 'structs-webapp'; sel()[0].dispatchEvent(new w.Event('change'));
  const filtered = await until(() => calls().find((c) => c.args.filters.interface === 'structs-webapp'));
  check('a filter is a param too', !!filtered);

  // ── Versions ──
  sel()[3].value = 'version'; sel()[3].dispatchEvent(new w.Event('change'));
  check('Compare: tutorial version', !!(await until(() => calls().find((c) => c.args.filters.compare === 'version'))));
  await until(() => /tutorial-3/.test(text(host.querySelector('.ob-compare .ob-head'))));
  go('Overview');
  check('OVERVIEW compares designs side by side', [...host.querySelectorAll('.ob-compare .ob-head .ob-c')].map(text).join('|') === '|tutorial-4|tutorial-3');
  go('Runs');
  check('RUNS: each design has its own rows by run', host.querySelectorAll('.ob-run-compare .ob-row[data-run]').length === 4 && /^tutorial-3 · 1/.test(text(host.querySelectorAll('.ob-run-compare .ob-row[data-run]')[2])));

  // ── A population the servers cannot count ──
  sel()[3].value = ''; sel()[3].dispatchEvent(new w.Event('change'));
  await until(() => calls().filter((c) => !c.args.filters.compare).length > 1);
  sel()[2].value = 'active'; sel()[2].dispatchEvent(new w.Event('change'));
  await until(() => calls().find((c) => c.args.filters.activity === 'active'));
  go('Overview');
  await until(() => /sample of/.test(text(host.querySelector('.ob-view'))));
  const at = [...host.querySelectorAll('.ob-view .ob-title')].map(text);
  check('split by activity, the path falls back to the sample and says so, and signup steps aside', at.some((t) => /^New player path · sample of/.test(t)) && !host.querySelector('.ob-path .ob-row[data-path="Started signup"]'), at.join('|'));
  sel()[2].value = ''; sel()[2].dispatchEvent(new w.Event('change'));
  await until(() => host.querySelector('.ob-path .ob-row[data-path="Started signup"]'));
  // ── Replicants ──
  const box = () => host.querySelector('.ob-controls .sui-checkbox-container input');
  check('a Replicants checkbox, unticked', box() && box().checked === false && !box().disabled);
  go('Health');
  check('the footer counts humans and names the replicants set aside', /of 445 humans/.test(text(host.querySelector('.ob-foot'))) && /9,167 replicants under 9 primaries/.test(text(host.querySelector('.ob-foot'))), text(host.querySelector('.ob-foot')));
  box().checked = true; box().dispatchEvent(new w.Event('change'));
  check('ticking it asks with replicants', !!(await until(() => calls().find((c) => c.args.filters.replicants === true))));
  await until(() => box() && box().checked);
  await until(() => /of 9,612 players/.test(text(host.querySelector('.ob-foot'))));
  check('…and the footer then counts every player', /of 9,612 players/.test(text(host.querySelector('.ob-foot'))), text(host.querySelector('.ob-foot')));
  sel()[3].value = 'replicant'; sel()[3].dispatchEvent(new w.Event('change'));
  check('Compare: Human / replicant', !!(await until(() => calls().find((c) => c.args.filters.compare === 'replicant'))));
  await until(() => /Replicants/.test(text(host.querySelector('.ob-compare .ob-head'))) || /Replicants/.test(text(host.querySelector('.ob-dist'))));
  check('comparing them ticks and locks the box', box() && box().checked && box().disabled);
  go('Overview');
  const rh = [...host.querySelectorAll('.ob-compare .ob-head .ob-c')].map(text).join('|');
  check('OVERVIEW compares humans with replicants', rh === '|Humans|Replicants', rh);
  go('Signup');
  check('replicants have no signup funnel, so Signup shows the humans alone', host.querySelector('.ob-view .ob-funnel') && !host.querySelector('.ob-view .ob-compare'));

  check('the card is titled Telemetry', /^Telemetry\b/.test(text(d.querySelector('#tm-grid .tm-card[data-card="' + id + '"] .tm-title'))), text(d.querySelector('#tm-grid .tm-card[data-card="' + id + '"] .tm-title')));
  check('while the crawl runs the status says so with the in-progress glyph', !!host.querySelector('.ob-status .icon-in-progress') && /Reading…/.test(text(host.querySelector('.ob-status'))));
}

// ── Cold start: nothing read yet ──
w.__HARNESS_OB_COLD__ = 'reading';
const cold = T.add('onboarding', {}, 3);
const coldId = (cold && cold.id) || 'onboarding-2';
const coldHost = await until(() => {
  const c = d.querySelector('#tm-grid .tm-card[data-card="' + coldId + '"] .tm-body');
  return c && c.querySelector('.ob') ? c : null;
});
const coldView = () => coldHost && coldHost.querySelector('.ob-view, .ob-main > .sui-message-inline-alert');
check('with nothing read and the crawl running, the page is a loading block, not zero tiles',
  coldHost && !coldHost.querySelector('.ob-hud') && coldHost.querySelector('.ob-main > .sui-message-inline-alert .icon-in-progress') && /Reading every guild/.test(text(coldView())), coldHost && text(coldHost));
const cgo = (label) => { [...coldHost.querySelectorAll('.ob .sui-screen-nav-item')].find((a) => text(a) === label).click(); };
cgo('Runs');
check('Runs still draws: it comes from the servers, not the crawl', coldHost && coldHost.querySelector('.ob-runs .ob-row[data-session]'));
cgo('Signup');
check('Signup still draws: it comes from the servers, not the crawl', coldHost && coldHost.querySelector('.ob-funnel .ob-row[data-step]'));
w.__HARNESS_OB_COLD__ = 'done';
T.refresh(coldId, true);
cgo('Tutorial');
const settled = await until(() => coldHost.querySelector('.ob-view .sui-message-inline-alert .icon-info') ? coldHost : null);
check('once the crawl finished empty-handed, the page says there is nothing', settled && /No tutorial sessions yet/.test(text(coldHost.querySelector('.ob-view'))), coldHost && text(coldHost.querySelector('.ob-view')));
delete w.__HARNESS_OB_COLD__;

// ── Wiring ──
check('the command is registered with Tauri', /onboarding::terminal_onboarding/.test(read('src-tauri/src/main.rs')));
check('and reachable from the web board, filters and all', /"terminal_onboarding"/.test(read('src-tauri/src/mcp/web_board.rs')) && /body\.get\("filters"\)/.test(read('src-tauri/src/mcp/web_board.rs')));
check('the desktop build reports its own interface, guarded against upstream drift',
  /ONBOARDING_INTERFACE_NAME = 'structs-desktop'/.test(read('scripts/apply-patches.sh')) && /verify_patched [^\n]*OnboardingTelemetry\.js/.test(read('scripts/apply-patches.sh')));
const refresh = read('src-tauri/src/mcp/onboarding_players.rs').split('pub async fn refresh_replicants')[1] || '';
check('replicants come from the chain first: the guild\'s list runs short', refresh.indexOf('read_replicants()') >= 0 && refresh.indexOf('read_replicants()') < refresh.indexOf('/api/permission/all'));
check('every outcome in the strip has a colour', ['completed', 'declined', 'left', 'playing'].every((k) => new RegExp('\\.ob-seg-' + k + ' \\{ background').test(read('frontend/onboarding.css'))));
check('the Chart card can plot the daily record', /"source": "telemetry"/.test(read('src-tauri/src/mcp/charts.rs')) && /"telemetry" =>/.test(read('src-tauri/src/mcp/charts.rs')));
check('the record keeps going at launch for a player who has one', /resume_history_ticker\(\)/.test(read('src-tauri/src/game_state.rs')));
check('board.html loads the script and the sheet', /board-terminal-onboarding\.js/.test(read('frontend/board.html')) && /onboarding\.css/.test(read('frontend/board.html')));

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
