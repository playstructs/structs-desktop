// The Sector Blitz contest cards (board-terminal-contest.js) against the static harness.
//
//   bash scripts/make_harness.sh && node scripts/harness-tests/contest.test.mjs
//
// The brief this pins: eight READ-ONLY ⌘K cards over the guild's influence
// API — CONTEST, STANDINGS, RACE, TERRITORY, IP, LEADERS, HUNT, CLAIMS — whose
// doors open things (a player, a guild, the map, another card) and never sign.
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
await until(() => w.Board && w.Board.Terminal && w.Board.Terminal.add && w.Board.Terminal.contest);
const T = w.Board.Terminal;
const X = T.contest;
check('the contest module loaded', !!X);

// ── ⌘K grammar ──
const P = (l) => T.parse(l);
check('CONTEST and BLITZ open the contest card', P('CONTEST').type === 'contest' && P('BLITZ').type === 'contest');
check('CONTEST #1 names a contest', P('CONTEST #1').params.contest === '1');
check('STANDINGS 127 focuses a sector; 044 reads as 44', P('STANDINGS 127').params.sector === '127' && P('SECTORS 044').params.sector === '44');
check('LEADERS guilds 999 reads both words, in either order', P('LEADERS guilds 999').params.kind === 'guilds' && P('LEADERS 999 guilds').params.sector === '999' && P('LEADERBOARD').type === 'leaders');
check('RACE, TERRITORY, HUNT and CLAIMS open their cards', P('RACE 44').type === 'race' && P('TERRITORY 127').type === 'territory' && P('HUNT undefeated').params.undefeated === '1' && P('CLAIMS mine').params.show === 'mine');
check('IP takes a guild, a player or a planet', P('IP 0-7').type === 'influence' && P('IP 1-61').params.id === '1-61' && P('INFLUENCE 2-41').params.id === '2-41');
check('IP refuses other kinds of id', P('IP 5-12') === null && P('IP') === null);
check('subject first: 0-7 IP', P('0-7 IP') && P('0-7 IP').type === 'influence' && P('0-7 IP').params.id === '0-7');
check('a guild, a player and a planet each offer IP', ['0-7', '1-61', '2-41'].every((id) => T.functionsFor(id).some((f) => f.word === 'IP' || f.word === 'INFLUENCE')));
const empty = T.suggestFor('');
const contestRows = empty.filter((r) => r.group === 'Contest');
check('the card menu files all eight under Contest', contestRows.length === 8, contestRows.map((r) => r.words).join());
const lead = contestRows.find((r) => r.words === 'LEADERS' || /LEADERS/.test(r.words));
check('a word that reads its own arguments shows its hint', lead && /guilds\|players/.test(lead.arg), JSON.stringify(lead));
check('typing completes contest words', T.suggestFor('STAN').some((r) => /STANDINGS/.test(r.words)));

// ── Pure pieces ──
check('the live contest wins; else the newest final; a named one or nothing',
  X.pickContest([{ contest_id: '1', status: 'final', end_height: '5' }, { contest_id: '2', status: 'active', start_height: '9' }]).contest_id === '2'
  && X.pickContest([{ contest_id: '1', status: 'final', end_height: '5' }, { contest_id: '3', status: 'final', end_height: '8' }]).contest_id === '3'
  && X.pickContest([{ contest_id: '1', status: 'final' }], '1').contest_id === '1' && X.pickContest([{ contest_id: '1' }], '9') === null);
const mx = X.matrix([
  { guild_id: '0-1', sector: 44, points: '300', overall_points: '500', unique_planets: '1', held_planets: '1' },
  { guild_id: '0-2', sector: 44, points: '300', overall_points: '300', unique_planets: '3', held_planets: '0' },
  { guild_id: '0-1', sector: 127, points: '200', overall_points: '500', unique_planets: '0', held_planets: '1' },
  { guild_id: '0-2', sector: 127, points: '0', overall_points: '300', unique_planets: '0', held_planets: '0' },
], [44, 127]);
check('ties share a lead; zero never leads', mx.leaders[44].join() === '0-1,0-2' && mx.leaders[127].join() === '0-1' && mx.top[127] === 200);
check('guilds order by overall points', mx.guilds[0].guild_id === '0-1');
const pl = X.pathToLead(200, 100, 200, 4);
check('200 behind: 2 wins tie, 3 pass, 1 claim taken passes', pl.tie === 2 && pl.pass === 3 && pl.flips === 1 && pl.flipsPossible, JSON.stringify(pl));
check('a claim takeover the leader cannot give is marked', X.pathToLead(1900, 100, 200, 2).flipsPossible === false && X.pathToLead(1900, 100, 200, 2).flips === 5);
check('an uneven gap cannot be tied, only passed', X.pathToLead(150, 100, 200).tie === null && X.pathToLead(150, 100, 200).pass === 2);
const planet = { holder_guild_id: '0-7', guild_coverage: [{ guild_id: '0-7', supporter_count: '2' }, { guild_id: '0-2', supporter_count: '1' }] };
check('a win is worth the unique bonus unless credited, the claim unless held',
  X.worthFor(planet, '0-7', 100, 200).total === 0 && X.worthFor(planet, '0-2', 100, 200).total === 200 && X.worthFor(planet, '0-9', 100, 200).total === 300);
check('your own guild\'s planet is worth nothing', X.worthFor(planet, '0-9', 100, 200, '0-9').own === true && X.worthFor(planet, '0-9', 100, 200, '0-9').total === 0);
check('no guild, no worth', X.worthFor(planet, null, 100, 200) === null);
const rw = X.repeatWins('41', [{ unique_planets: '30' }, { unique_planets: '22' }]);
check('repeat wins are member wins beyond the guild\'s unique count', rw.member_wins === 52 && rw.repeat === 11 && Math.round(rw.share * 100) === 21);
check('buckets are whole hundreds and keep the series short', X.bucketFor(58411, 120) === 500 && X.bucketFor(50, 120) === 100);
const series = X.seriesOf({ opening: [{ guild_id: 'a', points: '100' }], samples: [{ guild_id: 'a', height: '20', points: '300', points_delta: '200' }] }, (r) => r.guild_id, 10);
check('a series starts at its opening balance', series.a.length === 2 && series.a[0].h === 9 && series.a[0].v === 100 && series.a[1].v === 300);
check('pace is points per 1,000 blocks', X.paceOf([{ h: 0, v: 0 }, { h: 2000, v: 400 }], 10000) === 200);
const tl = X.leadTimeline({ a: [{ h: 1, v: 100 }, { h: 2, v: 100 }, { h: 3, v: 100 }], b: [{ h: 1, v: 0 }, { h: 2, v: 100 }, { h: 3, v: 200 }] }, ['a', 'b']);
check('lead changes: a tie, then a pass', tl.changes.length === 2 && tl.changes[0].leaders.length === 2 && tl.changes[1].leaders.join() === 'b', JSON.stringify(tl.changes));
const tape = X.tapeRows({ opening: [{ guild_id: 'a', sector: 44, points: '100' }, { guild_id: 'b', sector: 44, points: '0' }],
  samples: [{ guild_id: 'a', sector: 44, start_height: '1', height: '10', points: '100', unique_delta: '0', claim_delta: '0', points_delta: '0' },
    { guild_id: 'b', sector: 44, start_height: '1', height: '10', points: '300', unique_delta: '1', claim_delta: '1', points_delta: '300' }] }, 1);
check('the tape lists who moved and when the lead changed hands', tape.some((r) => r.kind === 'lead' && r.leaders.join() === 'b') && tape.some((r) => r.kind === 'claim' && r.guild_id === 'b' && r.points === 300) && !tape.some((r) => r.guild_id === 'a' && r.kind !== 'lead'), JSON.stringify(tape));
check('a guild API error reads as its sentence', X.errText('Guild API 503 http://x/api/influence/contests/2: Contest has no complete published scoring snapshot') === 'Contest has no complete published scoring snapshot');
check('a hunt row that would take or tie a lead says so',
  X.leadEffect(mx, '0-2', 127, 300) === 'Takes the lead in 127' && X.leadEffect(mx, '0-2', 127, 200) === 'Ties the lead in 127' && X.leadEffect(mx, '0-2', 44, 100) === 'Breaks the tie in 044' && X.leadEffect(mx, '0-2', 127, 100) === null);

// ── The cards ──
const before = (w.__HARNESS_CALLS__ || []).length;
async function mount(type, params, want) {
  const card = T.add(type, params, 2);
  const id = card && card.id;
  const host = await until(() => {
    const el = id ? d.querySelector('.tm-card[data-card="' + id + '"]') : null;
    const ipc = el && el.querySelector('.ipc');
    return ipc && want.test(text(ipc)) ? ipc : null;
  });
  return host;
}
const contest = await mount('contest', {}, /Sector control/);
check('CONTEST: live status, the clock and the rules', contest && /LIVE/.test(text(contest)) && /41,590/.test(text(contest)) && /100 IP/.test(text(contest)) && /200 IP/.test(text(contest)), contest && text(contest).slice(0, 300));
check('CONTEST: each sector names its leader; 999 is a tie', contest && /Sector 044.*VNT/.test(text(contest)) && /Tied lead/.test(text(contest)));
check('CONTEST: the winner now is VNT with 2 sectors', contest && /Winning now/.test(text(contest)) && /2 sectors/.test(text(contest)));
check('CONTEST: the earlier contest is listed', contest && /#1/.test(text(contest)) && /Final/.test(text(contest)));
check('CONTEST: says how fresh it is', contest && /build 7 · scored to 3,598,410/.test(text(contest)));

const stand = await mount('standings', { sector: '127' }, /Path to the lead/);
check('STANDINGS: the matrix and the path to the lead in 127', stand && /Path to the lead · Sector 127/.test(text(stand)) && /1,600/.test(text(stand)) && /17 pass/.test(text(stand)), stand && text(stand).slice(0, 400));
check('STANDINGS: our guild is marked', stand && stand.querySelector('tr.ipc-mine'));

const race = await mount('race', {}, /Lead changes|At end/);
check('RACE: a chart with a line per guild and a projection', race && race.querySelectorAll('path.ipc-line').length >= 5 && race.querySelectorAll('path.ipc-proj').length >= 1);
const rows = race ? race.querySelectorAll('tr.ipc-toggle') : [];
if (rows[0]) rows[0].dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
const race2 = [...d.querySelectorAll('.ipc')].find((n) => n.querySelector('tr.ipc-off'));
check('RACE: a legend row hides its guild', !!race2);

const terr = await mount('territory', { sector: '127' }, /Raided/);
check('TERRITORY: one cell per planet', terr && terr.querySelectorAll('button.ipc-cell').length === 48);
terr && terr.querySelector('button.ipc-cell').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
const terr2 = await until(() => [...d.querySelectorAll('.ipc')].find((n) => /Worth to us/.test(text(n)) && n.querySelector('.ipc-detail .form-fact')));
check('TERRITORY: a picked planet shows its facts and doors', terr2 && /Map/.test(text(terr2.querySelector('.ipc-detail'))));

const ipg = await mount('influence', { id: '0-7' }, /Members/);
check('IP guild: rank, sectors, members and repeat wins', ipg && /By sector/.test(text(ipg)) && /Kestrel Nine/.test(text(ipg)) && /Repeat wins/.test(text(ipg)), ipg && text(ipg).slice(0, 400));
const ipp = await mount('influence', { id: '1-61' }, /By sector/);
check('IP player: rank, the player ahead and the sectors', ipp && /To #3/.test(text(ipp)) && /Sector 999/.test(text(ipp)), ipp && text(ipp).slice(0, 400));
const ipl = await mount('influence', { id: '2-4117' }, /worth/);
check('IP planet: claim, last win, coverage and worth per guild', ipl && /Claim/.test(text(ipl)) && /Last win/.test(text(ipl)) && /Credited/.test(text(ipl)) && /owner/.test(text(ipl)), ipl && text(ipl).slice(0, 500));
const ipx = await mount('influence', { id: '1-999' }, /no score|not a contest participant/);
check('IP of someone who never scored says so', !!ipx || [...d.querySelectorAll('.sui-message-inline-alert')].some((n) => /has no score/.test(text(n))));

const lb = await mount('leaders', { kind: 'players' }, /ranked/);
check('LEADERS: players with ranks, and our row marked', lb && /#1/.test(text(lb)) && /Sable Wren/.test(text(lb)) && lb.querySelector('.ipc-mine'));
const lbg = await mount('leaders', { kind: 'guilds' }, /Slow Tide/);
check('LEADERS guilds: sectors controlled', lbg && /2 ctrl/.test(text(lbg)));

const hunt = await mount('hunt', {}, /Targets/);
check('HUNT: scoring targets only, gains first, lead changes flagged', hunt && /\+300/.test(text(hunt)) && !/Brask Vey/.test(text(hunt)) && /worth nothing hidden/.test(text(hunt)) && hunt.querySelector('.ipc-flag'), hunt && text(hunt).slice(0, 500));

const tapeCard = await mount('claims', {}, /beat/);
const liveRows = tapeCard ? tapeCard.querySelectorAll('a.ipc-tape.ipc-live') : [];
check('CLAIMS live: planet-level rows from the stream, newest first', tapeCard && /LIVE/.test(text(tapeCard)) && liveRows.length === 4 && /LEAD/.test(text(liveRows[0])) && /2-4410/.test(text(liveRows[1])), tapeCard && text(tapeCard).slice(0, 400));
check('CLAIMS live: a raid names who won, the claim move and what it cost us', liveRows[1] && /beat/.test(text(liveRows[1])) && /claim VNT → HLX/.test(text(liveRows[1])) && /−200/.test(text(liveRows[1])), liveRows[1] && text(liveRows[1]));
check('CLAIMS live: a member move says who it credits and uncredits', liveRows[3] && /credits VNT/.test(text(liveRows[3])) && /uncredits ORE/.test(text(liveRows[3])));
check('CLAIMS live: history only below the first live block, under its own heading', tapeCard && /Earlier · by guild/.test(text(tapeCard)));
check('CLAIMS live: our own events are marked', tapeCard && tapeCard.querySelectorAll('a.ipc-tape.ipc-live.ipc-mine').length === 4);
liveRows[1] && liveRows[1].dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
check('CLAIMS live: a row opens the planet\'s dossier', (T.state.layout.cards || []).some((c) => c.type === 'influence' && c.params.id === '2-4410'));
const lr = X.liveRow({ kind: 'raid', height: '10', gains: [{ guild_id: '0-7', points: 300 }], raid: { attacker_guild: '0-7', defender_guild: '0-2' }, credited: null });
check('a live row knows every guild it touches, and a first sight\'s credit is unknown', lr.guilds.join() === '0-7,0-7,0-2' && lr.credited === null && X.keepRow(lr, 'mine', '0-2') && !X.keepRow(lr, 'lead', '0-2'));
// A pushed frame refreshes the card without waiting for its cadence.
const tapeCalls = () => (w.__HARNESS_CALLS__ || []).filter((c) => c.cmd === 'terminal_influence_tape').length;
const beforePush = tapeCalls();
(w.__HARNESS_LISTENERS__['influence-tape'] || []).forEach((cb) => cb({ payload: { contest_id: '2', events: [] } }));
check('CLAIMS: an influence-tape event re-reads the tape', !!(await until(() => tapeCalls() > beforePush, 4000)));
// No stream: the card says so and reads history.
w.__INFLUENCE_LIVE__ = false;
const quiet = await mount('claims', { show: '' , sector: '44' }, /HISTORY/);
check('CLAIMS without a stream: says so and shows the history rows', quiet && /GRASS not connected/.test(text(quiet)) && quiet.querySelectorAll('a.ipc-tape').length > 0 && !quiet.querySelector('a.ipc-live'), quiet && text(quiet).slice(0, 300));
w.__INFLUENCE_LIVE__ = undefined;

// ── Read only ──
const calls = (w.__HARNESS_CALLS__ || []).slice(before).map((c) => c.cmd);
const contestCalls = calls.filter((c) => /^terminal_influence/.test(c));
check('the cards asked the influence commands', contestCalls.length > 5);
const src = read('frontend/board-terminal-contest.js');
const invoked = [...src.matchAll(/invoke\('([a-z_]+)'/g)].map((m) => m[1]);
check('the module invokes only influence reads', invoked.length > 0 && invoked.every((c) => /^terminal_influence(_\w+)?$/.test(c)), invoked.join());
check('nothing in the module signs, queues or acts', !/mcp_action|mcp_struct_act|sign_with|tx_retry|mcp_players\(/.test(src));
const rust = read('src-tauri/src/mcp/influence.rs') + read('src-tauri/src/mcp/influence_stream.rs');
check('the Rust side only GETs', !/\.post\(|post_public|\bsign\b|sign_with|tx_retry/.test(rust.replace(/\/\/.*$/gm, '')));
check('every contest command is reachable from the web board', ['terminal_influence"', 'terminal_influence_hunt', 'terminal_influence_territory', 'terminal_influence_planet', 'terminal_influence_me', 'terminal_influence_tape'].every((c) => read('src-tauri/src/mcp/web_board.rs').includes(c)));

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
