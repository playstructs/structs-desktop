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
  w.__HARNESS_CALLS__.some((c) => c.cmd === 'open_chat_window'));

dom.window.close();
console.log(failures ? `\n${failures} failing check(s)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
