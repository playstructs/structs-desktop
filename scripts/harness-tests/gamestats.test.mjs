// Game Stats page checks against the static harness — no Tauri, no rebuild.
//
//   bash scripts/make_harness.sh
//   (cd scripts/harness-tests && npm install && npm test)
//
// jsdom does NO layout: these assertions are structural (what rendered, what
// was invoked, what the synthetic events changed). Overflow/column behaviour
// is checked once in a real browser before a release build.
import { JSDOM } from 'jsdom';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const harness = resolve(repo, 'frontend', '_harness.html');
if (!existsSync(harness)) {
  console.error('missing frontend/_harness.html — run: bash scripts/make_harness.sh');
  process.exit(2);
}

let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? '  ok ' : 'FAIL ') + name + (ok || detail == null ? '' : ' — ' + detail));
  if (!ok) failures++;
}

function load(query) {
  return JSDOM.fromFile(harness, {
    url: pathToFileURL(harness).href + query,
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
  });
}

async function until(fn, ms = 5000) {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await new Promise((r) => setTimeout(r, 50));
  }
}

// ── Scenario 1: default fixture, solo gamestats ─────────────────────────────
{
  const dom = await load('?view=gamestats');
  const w = dom.window;
  await until(() => w.document.getElementById('gamestats-body')?.querySelector('.fstat'));
  const calls = (w.__HARNESS_CALLS__ || []).map((c) => c.cmd);
  const snapshotCalls = calls.filter((c) => c === 'mcp_game_stats_snapshot').length;
  check('pull-on-load: exactly one snapshot invoke', snapshotCalls === 1, 'got ' + snapshotCalls);
  check('solo attribute set', w.document.documentElement.getAttribute('data-solo') === 'gamestats');
  check('subnav is empty in solo mode', w.document.querySelectorAll('#board-subnav a').length === 0);

  const body = w.document.getElementById('gamestats-body');
  const rows = body.querySelectorAll('.sui-result-rows')[0];
  check('player leaderboard renders 25 rows', rows && rows.children.length === 25,
    'got ' + (rows ? rows.children.length : 'none'));
  const first = rows.children[0];
  check('rank + name + tag on row 1', /#1\s/.test(first.textContent) && /\[G\d\]/.test(first.textContent),
    first.textContent.slice(0, 60));
  check('…with the guild on its own line, not crowding the id',
    !!first.querySelector('.pc-guild') && /^\[G\d\] /.test(first.querySelector('.pc-guild').textContent)
    && /^#1-\d+$/.test(first.querySelector('.pc-id').textContent.trim()),
    first.querySelector('.pc-id')?.textContent + ' | ' + first.querySelector('.pc-guild')?.textContent);
  check('string numerics format (players tile)', body.textContent.includes('2,662'));
  // No word under the number: the glyph says alpha, the title says it on hover.
  check('default metric is alpha, Kg ladder',
    !!first.querySelector('.pc-res .sui-icon-alpha-matter') && /49\.34Kg/.test(first.textContent)
    && !/alpha/.test(first.textContent),
    first.textContent.slice(0, 80));
  check('a leaderboard row is the shared player row', first.classList.contains('pc-row'));
  const guilds = body.querySelectorAll('.sui-result-rows')[1];
  check('guild leaderboard renders', guilds && guilds.children.length === 5,
    'got ' + (guilds ? guilds.children.length : 'none'));
  check('guild order is the directory order', /SN Corp/.test(guilds.children[0].textContent));
  check('a guild is the shared guild row', guilds.children[0].classList.contains('gc-row')
    && guilds.children[0].getAttribute('data-guild-id') === '0-1'
    && /^#1 /.test(guilds.children[0].querySelector('.pc-name').textContent));
  check('…with its tag, mark and four readings',
    /\[SNC\]/.test(guilds.children[0].textContent)
    && !!guilds.children[0].querySelector('.gc-emblem img')
    && guilds.children[0].querySelectorAll('.pc-res').length === 4);
  check('…and no captions', !/Members|Capacity|Planets/.test(guilds.children[0].textContent),
    guilds.children[0].textContent.slice(0, 80));
  check('a guild without a mark gets the glyph', !!guilds.children[1].querySelector('.gc-emblem .icon-guild'));
  check('sparklines render', body.querySelectorAll('#gs-trends svg path').length >= 5);
  check('7-day history sparklines render from the aggregate endpoint',
    /stored ore — 7 days/.test(body.textContent) && /structs draw — 7 days/.test(body.textContent)
    && body.querySelectorAll('#gs-trends svg').length >= 7);
  check('history skips leading nulls (absence is not zero)',
    (() => { const vals = []; /* first 4 buckets are null in the fixture; the ore line's min must be ~8812, not 0 */
      const t = [...body.querySelectorAll('#gs-trends .ops-val')].map((n) => n.textContent);
      return t.some((x) => /Kg|g/.test(x)); })());
  check('energy card is gone, grid tile remains', ![...body.querySelectorAll('.sui-data-card-header')].some((h) => h.textContent === 'ENERGY GRID')
    && /draw \/ delivered/i.test(body.textContent));
  check('trends card is full-width (not inside the column grid)',
    (function () { var tr = [...body.querySelectorAll('.sui-data-card-header')].find((h) => /TRENDS/.test(h.textContent));
      return tr && !tr.closest('div[style*="grid-template-columns"]'); })());
  check('all three metrics offered', [...body.querySelectorAll('select option')].length === 3);
  check('24h tiles render', /Active/.test(body.textContent) && /Destroyed/.test(body.textContent));
  const universe = [...body.querySelectorAll('.sui-data-card-header')].some((h) => h.textContent === 'UNIVERSE');
  check('totals live in a titled UNIVERSE card', universe);
  check('ore is split stored vs in-ground', /Stored Ore/.test(body.textContent) && /Ore In Ground/.test(body.textContent));

  // Synthetic block tick: height updates, no new invoke, series grows.
  const before = w.__HARNESS_CALLS__.length;
  const svgBefore = body.querySelector('#gs-trends svg path').getAttribute('d');
  w.__HARNESS_EMIT__('game-stats-update', { tier: 'block', height: 4300001,
    point: { height: 4300001, events: 99, combat: 1, tx: 2, raids: 1, structs: 6041, fuel: 1 } });
  const blockTile = body.querySelector('.fstat .fstat-v');
  check('block tick bumps header height', blockTile.textContent === '4,300,001', blockTile.textContent);
  check('block tick causes no invoke', w.__HARNESS_CALLS__.length === before);
  check('block tick extends the sparkline', body.querySelector('#gs-trends svg path').getAttribute('d') !== svgBefore);

  // Raw grass fallback path.
  w.__HARNESS_EMIT__('grass-event', { category: 'block', subject: 'consensus', detail: { height: 4300002 } });
  check('grass block tick also bumps height', blockTile.textContent === '4,300,002', blockTile.textContent);

  // Sweep push: full re-render from the pushed snapshot, throttled.
  const snap = JSON.parse(JSON.stringify(await w.__TAURI__.core.invoke('mcp_game_stats_snapshot')));
  snap.totals.players = '31337';
  // Keep the pull fixture in step with the push: the page's 30s cadence
  // re-pulls the snapshot, and in the real app pull and push read the same
  // Rust cache — a harness where they disagree flakes this check whenever
  // the cadence timer lands inside the poll window.
  w.__HARNESS_FIXTURES__.mcp_game_stats_snapshot = snap;
  w.__HARNESS_EMIT__('game-stats-update', { tier: 'fast', snapshot: snap });
  w.__HARNESS_EMIT__('game-stats-update', { tier: 'fast', snapshot: snap });
  const rerendered = await until(() => body.textContent.includes('31,337'), 5000);
  check('sweep push re-renders totals', !!rerendered);
  w.close();
}

// ── Scenario 2: unauthenticated ─────────────────────────────────────────────
{
  const dom = await load('?view=gamestats&fixture=unauth');
  const w = dom.window;
  await until(() => (w.__HARNESS_CALLS__ || []).some((c) => c.cmd === 'mcp_game_stats_snapshot'));
  await until(() => w.document.getElementById('gamestats-body')?.textContent.includes('Guild API'));
  const body = w.document.getElementById('gamestats-body');
  check('unauth shows the login state block', body.textContent.includes('log in to Structs first'));
  check('unauth renders no leaderboards', body.querySelectorAll('.sui-result-row').length === 0);
  w.close();
}

// ── Scenario 3: Team Ops chrome untouched ───────────────────────────────────
{
  const dom = await load('');
  const w = dom.window;
  await until(() => w.Board && w.Board.current);
  const subnav = [...w.document.querySelectorAll('#board-subnav a')].map((a) => a.textContent);
  check('hidden Universe section absent from Command subnav',
    subnav.length === 2 && !subnav.includes('Universe'), JSON.stringify(subnav));
  check('gamestats page stays hidden on the main board',
    w.document.getElementById('page-gamestats').hidden === true);

  /* Manifest invariants. AREAS is the whole navigation, so a mistake in it is
   * a section a player cannot find or cannot tell apart, and nothing else
   * fails when it happens.
   */
  const sections = w.Board.AREAS.flatMap(
    (a) => a.sections.map((sec) => ({ area: a.label, ...sec })));

  // Two sections labelled "Doctrine" shipped in different areas, and the
  // sub-nav is all that distinguishes them: a player who remembered the word
  // could not know which one they wanted.
  const byLabel = {};
  sections.forEach((sec) => { (byLabel[sec.label] ||= []).push(sec.area); });
  const dupes = Object.entries(byLabel).filter(([, areas]) => areas.length > 1);
  check('no section label is used in two areas',
    dupes.length === 0, JSON.stringify(dupes));

  // A nav entry pointing at an unregistered page is a tab that goes nowhere.
  const orphans = sections.filter((sec) => !w.Board.pages[sec.page]);
  check('every section points at a registered page',
    orphans.length === 0, orphans.map((o) => o.label + '→' + o.page).join(', '));

  w.close();
}

// ── A leaderboard is a list of people ──────────────────────────────────────
// Who is actually around, and a way to reach them, is what turns a table of
// rivals into something you can act on. The same two affordances the roster
// carries, on the same players.
{
  console.log('\n— leaderboard is social');
  const dom = await load('?view=gamestats');
  const w = dom.window;
  const d = w.document;
  await until(() => d.getElementById('gamestats-body')?.querySelector('.fstat'));
  // Presence arrives on its own promise and repaints, so wait for the row to
  // actually carry it rather than racing the first paint.
  await until(() => d.querySelector('.pc-row .ops-presence') || d.querySelector('.pc-row .pc-act'));
  const rows = [...d.querySelectorAll('.pc-row')];
  const player = rows.find((n) => n.querySelector('.ops-presence') ||
    n.querySelector('.pc-act'));
  check('a leaderboard row carries the social affordances', !!player,
    rows.length ? rows[0].textContent.slice(0, 60) : 'no rows');

  if (player) {
    check('…whether they are around', !!player.querySelector('.ops-presence'),
      player.innerHTML.slice(0, 200));
    check('…and both ways to reach them',
      !!player.querySelector('.pc-act .icon-phone') && !!player.querySelector('.pc-act .icon-outgoing'),
      player.innerHTML.slice(0, 200));
    // Where to look: a planet and a fleet door when the row carries the ids —
    // the same spectator the roster opens — and no dead door when it does not.
    check('…and where to look',
      !!player.querySelector('.pc-act .icon-planet') && !!player.querySelector('.pc-act .icon-fleet-tile'),
      player.innerHTML.slice(0, 200));
    const noFleet = rows.find((n) => n.getAttribute('data-player-id') === '1-104');
    const nowhere = rows.find((n) => n.getAttribute('data-player-id') === '1-105');
    check('a player with no fleet gets no fleet door',
      !!noFleet && !!noFleet.querySelector('.pc-act .icon-planet') && !noFleet.querySelector('.pc-act .icon-fleet-tile'));
    check('a player with neither gets neither',
      !!nowhere && !nowhere.querySelector('.pc-act .icon-planet') && !nowhere.querySelector('.pc-act .icon-fleet-tile')
      && nowhere.querySelectorAll('.pc-act').length === 2);
  }

  // A guild row is not a person and must offer neither.
  const guild = [...d.querySelectorAll('.sui-result-row')].find((n) => /^#\d+\s+\S/.test(n.textContent.trim()) &&
    !n.querySelector('.pc-act') && n.textContent.includes('Members'));
  if (guild) {
    check('a guild row offers no message link', !guild.querySelector('.icon-phone'),
      guild.textContent.slice(0, 40));
  }
}

// ── When Comms is not connected ────────────────────────────────────────────
// The common case for anyone who has not signed in yet. These affordances
// used to put the reason in a `title` and nothing else, so the click did
// nothing a player could see.
{
  console.log('\n— reaching out with Comms off');
  const dom = await load('?view=gamestats');
  const w = dom.window;
  const d = w.document;
  await until(() => d.getElementById('gamestats-body')?.querySelector('.fstat'));
  await until(() => d.querySelector('.pc-row .pc-act'));

  // Every matrix call refuses, the way it does when nothing is signed in.
  w.__HARNESS_REJECT__ = w.__HARNESS_REJECT__ || {};
  w.__HARNESS_REJECT__.matrix_message_player =
    'Comms is not connected — open Comms to sign in';

  // The direct-message door (the watch doors come first when the row has a
  // planet and a fleet to look at).
  const link = d.querySelector('.pc-row .pc-act .icon-phone').closest('a');
  link.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 120));

  check('a failed click changes the glyph', !!link.querySelector('.icon-alert'),
    link.innerHTML.slice(0, 80));
  check('…so the click visibly landed', link.className.includes('err'),
    link.className);
  // The reason has to be one a player can act on, not an internal id.
  check('…and says what to do about it',
    link.title.includes('open Comms'), link.title);
  check('…naming the player, not their id alone',
    /could not message \S/.test(link.title), link.title);
}

// ── A chart must not invent readings ───────────────────────────────────────
//
// The producer's totals are empty until the first sweep lands, so the blocks
// before it genuinely have no structs/raids/draw figure. Recording those as 0
// put a false floor in the series: a sparkline scales from its own minimum, so
// one bogus zero flattened an hour of real movement into a sliver and drew a
// cliff out of a galaxy that had never been empty. Nulls, and a broken line.
{
  const dom = await load('?view=gamestats');
  const w = dom.window;
  await until(() => w.Board && w.Board._gamestats && w.Board._gamestats.state.snap);
  const G = w.Board._gamestats;
  const d = w.document;

  // The fixture's first three blocks carry nulls, as the real cold start does.
  const structs = G.seriesValues('structs');
  check('an unswept block reads as unknown, not as zero',
    structs.slice(0, 3).every((v) => v === null) && structs[3] > 0,
    JSON.stringify(structs.slice(0, 4)));

  // A genuine zero is data and must survive — the distinction the old
  // `Number(x) || 0` collapsed in both directions.
  G.state.snap.series = [{ z: 0 }, { z: null }, { z: 5 }];
  check('a real zero is kept while a gap stays a gap',
    JSON.stringify(G.seriesValues('z')) === '[0,null,5]',
    JSON.stringify(G.seriesValues('z')));

  const path = (vals) => {
    const p = G.sparkline(vals).querySelector('path');
    return p ? p.getAttribute('d') : '';
  };

  // The failure that renders as an empty chart with no error: one non-finite
  // value anywhere in `d` invalidates the whole attribute.
  const withGap = path([5, 6, null, 8, 9]);
  check('a gap never puts NaN in the path', !/NaN/.test(withGap), withGap);
  check('...and breaks the line rather than drawing through it',
    (withGap.match(/M/g) || []).length === 2, withGap);

  // The bug itself, stated as geometry: with the gap excluded from scaling,
  // the drawn points must span the chart's height. A false zero in the data
  // would pin the minimum to the floor and bunch every real value at the top.
  const ys = [...path([100, 101, null, 102, 103]).matchAll(/[ML][\d.]+ ([\d.]+)/g)]
    .map((m) => Number(m[1]));
  check('the gap does not drag the scale to zero',
    Math.max(...ys) - Math.min(...ys) > 40, JSON.stringify(ys));

  // Two samples with a gap between them are not a line: SVG draws two lone
  // movetos as nothing at all, and an empty chart with no caption reads as
  // broken rather than as early.
  const island = G.sparkline([5, null, 7]);
  check('an unjoinable pair says it is still collecting',
    !island.querySelector('path') && /collecting/.test(island.textContent),
    island.textContent);
  const empty = G.sparkline([null, null, null]);
  check('...as does a series with nothing in it yet',
    !empty.querySelector('path') && /collecting/.test(empty.textContent));

  w.close();
}

/* ── Explore reads the fields the API actually sends ───────────────────────
 *
 * Three shapes were guessed and all three were wrong against a live response:
 * the chain nests identity under `Player`, the ore stats are named
 * `mined`/`seized`/`forfeited`, and every guild-API figure ships a floored
 * display value beside a precise `_p` one. Reading the bare field fed 3 to a
 * base-unit formatter and rendered a 3 GRAM stake as "3mG".
 */
{
  console.log('\n— explore field names');
  // From the repo, not the cwd: `npm run test:all` runs inside harness-tests.
  const pages = readFileSync(resolve(repo, 'frontend', 'board-pages.js'), 'utf8');
  const explore = pages.slice(pages.indexOf('EXPLORE \u2192 PLAYER'));

  check('identity is read from the nested Player object',
    /function entPlayer\(ent\) \{ return \(ent && ent\.Player\)/.test(pages),
    'entity.planetId is undefined; entity.Player.planetId is the id');
  check('ore stats use the API\u2019s own names',
    /num\(ore, 'mined'\)/.test(explore) && /num\(ore, 'seized'\)/.test(explore)
    && /num\(ore, 'forfeited'\)/.test(explore),
    'ore_mined / ore_stolen / ore_lost do not exist and render as dashes');
  check('every money and power figure reads the precise `_p` field',
    /pnum\(i, 'fuel_p'\)/.test(explore) && /pnum\(i, 'power_p'\)/.test(explore)
    && /pnum\(a, 'power_p'\)/.test(explore),
    'the bare field is floored for display and is not in base units');

  /* The header is the game's own profile header, not a list row: a
   * `sui-result-row` is built for a LIST, and it made the subject of the page
   * look like one more entry in one. */
  check('the header uses the game\u2019s profile classes',
    /'profile-header'/.test(explore) && /'profile-header-image-container'/.test(explore)
    && /sui-text-display/.test(explore),
    'these are main.css classes the window already links');
  check('\u2026and not a roster row',
    !/function exploreHeader[\s\S]{0,900}?H\.resultRow/.test(explore));

  /* `H.resultTable()` already IS the `sui-result-rows` container. Nesting a
   * second one inside left the outer element with no rows of its own, and
   * SUI's `.sui-result-table.sui-result-rows:first-child { border-top }` drew
   * it as a bare line above the list. */
  check('rows go straight into the result table',
    !/H\.resultTable\(\);[\s\S]{0,160}?H\.el\('div', 'sui-result-rows'\)/.test(explore),
    'a nested rows container renders as a stray line above the first row');

  /* The guild's name and tag are not on the player entity — it carries a
   * `guildId` and nothing else — so a profile without that read can only name
   * the row in a database. */
  const rustPages = readFileSync(process.cwd() + '/src-tauri/src/mcp/tools/board_pages.rs', 'utf8');
  check('the profile reads the guild record too',
    /guild_by_id\(gid\)/.test(rustPages) && /"guild": guild,/.test(rustPages));
  check('\u2026and the header wears the tag from it',
    /var tag = guild && guild\.tag/.test(explore),
    'the chain entity has no guildTag field');
}

console.log(failures ? failures + ' failure(s)' : 'all checks passed');
process.exit(failures ? 1 : 0);
