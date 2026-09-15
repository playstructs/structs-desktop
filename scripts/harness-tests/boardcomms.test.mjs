// Does Team Ops know the guild is talking?
//
// The two halves of the app ran side by side without either knowing the other
// was busy: a player working the console could be named in a room and never
// find out. The indicator only means something because the sync loop runs
// app-wide from boot rather than with the Comms window, so `matrix_unread` is
// answerable whether or not that window was ever opened.
import { JSDOM } from 'jsdom';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const harness = resolve(repo, 'frontend', '_harness.html');
if (!existsSync(harness)) {
  console.error('missing frontend/_harness.html — run: bash scripts/make_harness.sh');
  process.exit(2);
}

let failures = 0;
const check = (name, ok, detail) => {
  console.log((ok ? '  ok ' : 'FAIL ') + name + (ok || detail == null ? '' : ' — ' + detail));
  if (!ok) failures++;
};

async function until(fn, ms = 5000) {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await new Promise((r) => setTimeout(r, 50));
  }
}

const dom = await JSDOM.fromFile(harness, {
  url: pathToFileURL(harness).href,
  runScripts: 'dangerously',
  resources: 'usable',
  pretendToBeVisual: true,
});
const w = dom.window;
const d = w.document;
await until(() => w.Board && w.Board.paintComms);

console.log('\n— comms indicator');
const btn = d.getElementById('board-comms');
check('Team Ops carries a Comms control', !!btn);

// The fixture says three unread, one of which named you.
await until(() => !btn.classList.contains('hidden'));
check('unread traffic surfaces it', !btn.classList.contains('hidden'),
  btn.className);
check('…with the count', d.getElementById('board-comms-count').textContent === '3',
  d.getElementById('board-comms-count').textContent);
// A mention is addressed to you; unread traffic merely happened.
check('…and a mention is marked apart from ordinary unread',
  btn.classList.contains('board-mod-mention'), btn.className);
check('…saying so in words too', /mentioned/i.test(btn.title), btn.title);

// Silence must be SILENT. A console showing a permanent zero is one people
// stop reading, which costs more than the indicator gains.
w.Board.paintComms({ count: 0, mention: false });
check('nothing to say means nothing on screen', btn.classList.contains('hidden'),
  btn.className);
check('…and no leftover count', d.getElementById('board-comms-count').textContent === '',
  d.getElementById('board-comms-count').textContent);

// Not signed in is the ordinary case for a player who has never opened Comms,
// and it reaches this code as a rejected promise, not as a number.
w.Board.paintComms(null);
check('Comms not connected is quiet, not an error', btn.classList.contains('hidden'));

// A mention with no unread count still has to show — the count is the
// decoration, the mention is the event.
w.Board.paintComms({ count: 0, mention: true });
check('a mention alone is still surfaced', !btn.classList.contains('hidden'),
  btn.className);

w.Board.paintComms({ count: 250, mention: false });
check('a big number is abbreviated rather than widening the bar',
  d.getElementById('board-comms-count').textContent === '99+',
  d.getElementById('board-comms-count').textContent);

// Clicking opens Comms rather than navigating the board somewhere.
w.Board.paintComms({ count: 1, mention: false });
btn.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
await new Promise((r) => setTimeout(r, 50));
check('clicking it opens Comms',
  w.__HARNESS_CALLS__.some((c) => c.cmd === 'matrix_open' && c.args.subject == null && c.args.draft == null));

// ── A row about a place opens the map there ────────────────────────────────
// The same window a click on the native notification opens.
console.log('\n— opening the map from a feed line');
{
  const feed = d.getElementById('feed-list');
  w.Board._feedAddForTest({ message: 'Raid armed — scout1', ts_ms: 2, severity: 'important', source: 'team', target: '2-33978' });
  const row = feed.firstChild;
  const door = row.querySelector('.feed-open');
  check('a feed line that names a planet carries a door to the map', !!door && door.dataset.target === '2-33978');
  check('…as quiet as the share door beside it', !!door && w.getComputedStyle(door).opacity === '0');
  door.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 50));
  const opened = w.__HARNESS_CALLS__.filter((c) => c.cmd === 'mcp_raid_view_open').pop();
  check('clicking it opens the Map Viewer on that planet', !!opened && opened.args.planetId === '2-33978', JSON.stringify(opened && opened.args));
  w.Board._feedAddForTest({ message: 'Fleet under fire', ts_ms: 3, severity: 'important', source: 'combat', target: '9-194' });
  feed.firstChild.querySelector('.feed-open').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 50));
  const fleet = w.__HARNESS_CALLS__.filter((c) => c.cmd === 'mcp_raid_view_open').pop();
  check('…and a fleet id follows the fleet', !!fleet && fleet.args.fleetId === '9-194');
  w.Board._feedAddForTest({ message: 'watchdog line', ts_ms: 4, severity: 'notice', source: 'watchdog' });
  check('a line about nothing in particular has no door', !feed.firstChild.querySelector('.feed-open'));
}

// ── Telling the guild ──────────────────────────────────────────────────────
// The console can hear Comms; this is the other direction. Everything the app
// notices on your behalf lived in a window only you can see.
console.log('\n— sharing a feed line');
{
  const feed = d.getElementById('feed-list');
  const push = (message, ts) => w.Board._feedAddForTest({
    message, ts_ms: ts || 1, severity: 'notice', source: 'auto_raid',
  });

  push('raid on 2-15361 lost 3 structs');
  const row = feed.firstChild;
  const share = row.querySelector('.feed-share');
  check('every feed line can be told to the guild', !!share);
  check('…without shouting: it is not a visible button', !!share
    && w.getComputedStyle(share).opacity === '0', share && w.getComputedStyle(share).opacity);

  share.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 50));
  const shared = w.__HARNESS_CALLS__.filter((c) => c.cmd === 'matrix_open').pop();
  check('it hands Comms a draft rather than posting',
    !!shared && shared.args.draft === 'raid on 2-15361 lost 3 structs' && shared.args.subject == null,
    JSON.stringify(shared && shared.args));
  check('…and the row remembers it was told', share.classList.contains('feed-shared'));

  // A repeated line FOLDS into the row above it and shows the newest numbers.
  // Sharing must send what is on screen, not the text the row was born with —
  // otherwise the guild is told a stale count.
  push('raid on 2-15361 lost 3 structs');
  push('raid on 2-15361 lost 9 structs');
  const folded = feed.firstChild;
  check('a repeated line folds rather than stacking',
    folded.querySelector('.feed-count').hidden === false,
    folded.textContent);
  folded.querySelector('.feed-share').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 50));
  const latest = w.__HARNESS_CALLS__.filter((c) => c.cmd === 'matrix_open').pop();
  check('…and sharing it tells the NEWEST numbers, not the first',
    !!latest && latest.args.draft === 'raid on 2-15361 lost 9 structs',
    JSON.stringify(latest && latest.args));

  // The internal source tag is for the console, not for people.
  check('the guild is not told our internal source tag',
    !/auto_raid/.test(latest.args.text), latest.args.text);
}

dom.window.close();
console.log(failures ? `\n${failures} failing check(s)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
