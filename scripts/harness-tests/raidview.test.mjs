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
  const btn = d.getElementById('rv-share');
  check('the raid window offers a share control', !!btn && !btn.classList.contains('hidden'));
  btn.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 20));
  const call = w.__HARNESS_CALLS__.filter((c) => c.cmd === 'matrix_share').pop();
  check('…which hands the planet under raid to Comms',
    !!call && call.args.text === '2-1', JSON.stringify(call && call.args));
}

console.log(failures ? failures + ' failure(s)' : 'all checks passed');
w.close();
process.exit(failures ? 1 : 0);
