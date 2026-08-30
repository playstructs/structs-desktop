// Raid viewer checks against the static harness — no Tauri, no rebuild.
//
//   bash scripts/make_harness.sh
//   (cd scripts/harness-tests && node raidview.test.mjs)
//
// jsdom does NO layout: geometry (board scaling, PiP offscreen math) is
// checked in a real browser; these assertions cover art selection, badge
// logic, destroy-state handling, the defence web, and the PiP hide fix.
import { JSDOM } from 'jsdom';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const harness = resolve(repo, 'frontend', '_harness_raid.html');
if (!existsSync(harness)) {
  console.error('missing frontend/_harness_raid.html — run: bash scripts/make_harness.sh');
  process.exit(2);
}

let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? '  ok ' : 'FAIL ') + name + (ok || detail == null ? '' : ' — ' + detail));
  if (!ok) failures++;
}
async function until(fn, ms = 5000) {
  const t0 = Date.now();
  for (;;) { const v = fn(); if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await new Promise((r) => setTimeout(r, 50)); }
}

const dom = await JSDOM.fromFile(harness, {
  url: pathToFileURL(harness).href + '?planet=2-1&label=raid-harness',
  runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true,
  // lottie's feature-detect probes a 2d canvas at parse time; jsdom has no
  // canvas, and the viewer already tolerates lottie being absent. A minimal
  // stub keeps the vendor lib from spraying errors over the test output.
  beforeParse(window) {
    window.HTMLCanvasElement.prototype.getContext = () => ({
      fillStyle: null, fillRect() {}, drawImage() {}, getImageData: () => ({ data: [] }),
      clearRect() {}, canvas: { width: 0, height: 0 },
    });
  },
});
const w = dom.window;
const RV = await until(() => w.RaidView && w.RaidView._state && w.RaidView._state.snapshot && w.RaidView);
check('board boots from the pull fixture', !!RV);
if (!RV) { console.log('aborting'); process.exit(1); }
const S = RV._state;

// ── Art injection (the Destroyer fix) ───────────────────────────────────────
{
  const d = w.document;
  const box = d.createElement('div');
  box.innerHTML =
    '<svg><g class="struct_init"><image href="images/img_22.png"></image></g>' +
    '<g class="struct_dmg"><image href="images/img_23.png"></image></g>' +
    '<g class="struct_top_layer_1"><image href="images/img_20.png"></image></g>' +
    '<g class="struct_top_layer_2"><image href="images/img_21.png"></image></g>' +
    '<g class="struct_bottom_layer_1"><image href="images/img_24.png"></image></g></svg>';
  const tank = S.structsById['5-1']; // 2/3 health → damaged
  RV.injectStructArt(box, tank, 2);
  const href = (cls) => { const i = box.querySelector('.' + cls + ' image');
    return i ? i.getAttribute('href') : null; };
  check('placeholder struct_init swapped for the REAL struct (damaged art)',
    href('struct_init') === 'img/structs/tank/tank-struct-dmg.png', href('struct_init'));
  check('top weapon layer swapped', href('struct_top_layer_1') === 'img/structs/tank/tank-top-weapon.png',
    href('struct_top_layer_1'));
  check('layers the struct has no art for are emptied (no leftover placeholder)',
    href('struct_top_layer_2') === null && href('struct_bottom_layer_1') === null);

  const box2 = d.createElement('div');
  box2.innerHTML = '<svg><g class="struct_init"><image href="images/img_22.png"></image></g></svg>';
  RV.injectStructArt(box2, S.structsById['5-5'], 3); // submersible at full health
  check('full-health struct gets base art',
    box2.querySelector('.struct_init image').getAttribute('href')
      === 'img/structs/submersible/submersible-struct-base.png');
}

// ── Badges ──────────────────────────────────────────────────────────────────
check('offline struct wears the game\'s energy-deactivated badge',
  RV._badgesFor(S.structsById['5-4']).includes('sui-icon-energy-deactivated'));
check('the old conflated no-power badge is gone',
  !RV._badgesFor(S.structsById['5-4']).includes('sui-icon-no-power'));

// ── Destroy persistence (struct_status bit 32) ──────────────────────────────
RV._applyDelta({ category: 'struct_status', detail: { struct_id: '5-2', status: 32 } });
check('destroy delta marks STATE, not just the DOM', S.structsById['5-2'].destroyed === true);
check('destroyed badge is now reachable',
  RV._badgesFor(S.structsById['5-2']).includes('sui-icon-destroyed'));
check('live health zeroed so nothing can resurrect the sprite', S.liveHealth['5-2'] === 0);

// ── Defence web overlay ─────────────────────────────────────────────────────
RV.selectStruct('5-3'); // the ward: 5-1 defends it (5-2 is now wreckage)
{
  const svg = w.document.getElementById('rv-defweb');
  check('selecting the ward draws the defence web', !!svg && svg.querySelectorAll('line').length >= 1,
    svg ? svg.querySelectorAll('line').length + ' lines' : 'no svg');
}
RV.selectStruct('5-3'); // toggle off
check('deselecting clears the web', !w.document.getElementById('rv-defweb'));
RV.selectStruct('5-1'); // a defender: web shows its ward link
{
  const svg = w.document.getElementById('rv-defweb');
  check('selecting a defender draws its ward link', !!svg && svg.querySelectorAll('line').length >= 1);
}
RV.selectStruct('5-1');

// ── PiP stale-sprite fix ────────────────────────────────────────────────────
RV._pip.structId = '5-1';
RV._pipRequestHide();
check('pipRequestHide forgets the struct immediately (no stale re-show)', RV._pip.structId === null);

// ── Talking about what you are watching ─────────────────────────────────────
// A spectator window is where you notice something worth telling the guild.
// Sharing hands the id to Comms as a draft; it must never post by itself.
{
  console.log('\n— share to comms');
  const d = w.document;
  // The control lives in the Comms panel, NOT the defender's status chunk: a
  // button between the portrait and the charge bar split one unit into two
  // unrelated tiles and read as an upload control.
  check('no share button in the defender status chunk',
    d.getElementById('rv-share') === null);
  const btn = d.getElementById('rv-chat-discuss');
  check('the raid window offers a share control', !!btn && !btn.classList.contains('hidden'));
  btn.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 20));
  const call = w.__HARNESS_CALLS__.filter((c) => c.cmd === 'matrix_share').pop();
  check('…which hands the planet under raid to Comms',
    !!call && call.args.text === '2-1', JSON.stringify(call && call.args));
}

// ── What people have said about this planet ────────────────────────────────
// The battle log is the chain's account of a raid; this is the guild's.
// Together they are the whole story, and a spectator window is where you are
// already looking at the thing being talked about.
{
  console.log('\n— comms panel');
  const d = w.document;
  const panel = d.getElementById('rv-chat');
  check('the raid window has a comms panel', !!panel);
  // Collapsed by default: the map is what the window is for.
  check('…collapsed, like the battle log', panel.classList.contains('rv-collapsed'));
  check('…and nothing is fetched until it is opened',
    w.__HARNESS_CALLS__.filter((c) => c.cmd === 'matrix_object_chatter').length === 0);

  d.getElementById('rv-chat-toggle')
    .dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 120));
  const call = w.__HARNESS_CALLS__.filter((c) => c.cmd === 'matrix_object_chatter').pop();
  check('opening it asks what was said', !!call && call.args.objectId === '2-1',
    JSON.stringify(call && call.args));
  const rows = d.querySelectorAll('.rv-chat-row');
  check('…and shows it', rows.length === 1, String(rows.length));
  check('…with who said it',
    rows[0].textContent.includes('JPEG') && rows[0].textContent.includes('shield on 2-1'),
    rows[0].textContent);
  // Which room it was said in is the part you cannot infer.
  check('…and where', rows[0].textContent.includes('SN.Corporation'), rows[0].textContent);

  // ── Answering from here ───────────────────────────────────────────────
  // The panel used to be read-only because sending "would mean guessing a
  // room". The guess was the problem, not the sending: the room is now shown
  // and picked, defaulting to wherever this object was actually discussed.
  const compose = d.getElementById('rv-chat-compose');
  check('the rail can answer, not just listen', !!compose);
  check('…once Comms answered with a guild and rooms',
    !compose.classList.contains('hidden'));
  const sel = d.getElementById('rv-chat-room');
  check('…offering every room, not one guessed for you',
    sel.options.length === 2, String(sel.options.length));
  // The fixture lists General FIRST and the discussed room second, so taking
  // the head of the list would pass by accident.
  check('…defaulting to where this object was actually discussed',
    sel.value === '!snc:h', sel.value);

  const input = d.getElementById('rv-chat-input');
  input.value = '  they are down to one shield  ';
  d.getElementById('rv-chat-send').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 60));
  const sent = w.__HARNESS_CALLS__.filter((c) => c.cmd === 'matrix_send').pop();
  check('sending goes to the chosen room',
    !!sent && sent.args.roomId === '!snc:h', JSON.stringify(sent && sent.args));
  check('…in the guild the read came from, not one inferred again',
    !!sent && sent.args.guildId === '0-5', JSON.stringify(sent && sent.args));
  check('…trimmed', !!sent && sent.args.body === 'they are down to one shield',
    JSON.stringify(sent && sent.args.body));
  check('…and the box is cleared so it cannot be sent twice', input.value === '');

  // A composer that cannot send is worse than none: it invites a message the
  // player will lose.
  {
    const before = w.__HARNESS_CALLS__.filter((c) => c.cmd === 'matrix_send').length;
    input.value = '   ';
    d.getElementById('rv-chat-send').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 40));
    check('whitespace sends nothing',
      w.__HARNESS_CALLS__.filter((c) => c.cmd === 'matrix_send').length === before);
  }

  // The map steers on keystrokes. A composer that pans the board while you
  // type is unusable.
  {
    let escaped = false;
    d.addEventListener('keydown', () => { escaped = true; });
    const ev = new w.KeyboardEvent('keydown', { key: 'a', bubbles: true });
    input.dispatchEvent(ev);
    check('typing does not reach the map', !escaped);
  }

  d.getElementById('rv-chat-discuss')
    .dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 120));
  const shared = w.__HARNESS_CALLS__.filter((c) => c.cmd === 'matrix_share').pop();
  check('discussing hands the planet to Comms', !!shared && shared.args.text === '2-1',
    JSON.stringify(shared && shared.args));
}

// ── The comms panel is live ────────────────────────────────────────────────
// A raid is live; the panel used to load once on open and then go stale
// during exactly the event it exists for.
{
  console.log('\n— live comms');
  const d = w.document;

  // `2-1` is a prefix of `2-15361`. Substring-matching chain ids has caused
  // real misattribution in this codebase before — an id must be bounded by
  // something that cannot continue it.
  const m = w.RaidView.mentionsObject;
  check('an id on its own is a mention', m('shield on 2-1 is down', '2-1'));
  check('…at the very start', m('2-1 is being raided', '2-1'));
  check('…at the very end', m('everyone to 2-1', '2-1'));
  check('…and next to punctuation', m('hit 2-1, now', '2-1'));
  check('a LONGER id that starts the same is not this one',
    !m('raiding 2-15361 at dawn', '2-1'), 'prefix collision');
  check('…nor one that ends the same', !m('see 12-1 there', '2-1'));
  check('…nor one glued to a word', !m('planet2-1x', '2-1'));

  // Closed panel: say something was said rather than silently changing a
  // number nobody is looking at.
  const head = d.getElementById('rv-chat-toggle');
  head.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));   // close it
  await new Promise((r) => setTimeout(r, 60));
  const before = w.__HARNESS_CALLS__.filter((c) => c.cmd === 'matrix_object_chatter').length;

  w.__HARNESS_EMIT__('matrix::timeline', {
    guild_id: '0-5', room_id: '!snc:h',
    messages: [{ event_id: '$n1', sender: '@1-61:h', body: 'shield on 2-1 is down', kind: 'text' }],
  });
  await new Promise((r) => setTimeout(r, 120));
  check('a message about this planet marks the closed panel',
    d.getElementById('rv-chat-count').textContent === 'new',
    d.getElementById('rv-chat-count').textContent);
  check('…without fetching for a panel nobody is looking at',
    w.__HARNESS_CALLS__.filter((c) => c.cmd === 'matrix_object_chatter').length === before,
    String(w.__HARNESS_CALLS__.filter((c) => c.cmd === 'matrix_object_chatter').length));

  // A message about a DIFFERENT planet must not mark it at all.
  d.getElementById('rv-chat-count').textContent = '';
  w.__HARNESS_EMIT__('matrix::timeline', {
    guild_id: '0-5', room_id: '!snc:h',
    messages: [{ event_id: '$n2', sender: '@1-61:h', body: 'raiding 2-15361', kind: 'text' }],
  });
  await new Promise((r) => setTimeout(r, 120));
  check('another planet does not mark this one',
    d.getElementById('rv-chat-count').textContent !== 'new',
    d.getElementById('rv-chat-count').textContent);

  // Opening clears the marker and fetches.
  head.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 150));
  check('opening it fetches again',
    w.__HARNESS_CALLS__.filter((c) => c.cmd === 'matrix_object_chatter').length > before);
  check('…and the marker is gone',
    d.getElementById('rv-chat-count').textContent !== 'new',
    d.getElementById('rv-chat-count').textContent);
}

console.log(failures ? failures + ' failure(s)' : 'all checks passed');
w.close();
process.exit(failures ? 1 : 0);
