// The sound designer card (board-terminal-sound.js) against the static harness.
//
//   bash scripts/make_harness.sh && node scripts/harness-tests/sounds-card.test.mjs
//
// What this pins: SOUNDS/SFX/AUDIO open the card; every catalogue group is a
// tab and every mount in a group is a row; a mapped mount shows its file as a
// chip and everything else says SILENT; settings write ONE debounced patch
// through sound_mount_set; the `sound-config` event repaints without another
// read; and the tape draws a `sound-trace` cue whose door picks a file for
// exactly that mount.
import { JSDOM } from 'jsdom';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const harness = resolve(repo, 'frontend', '_harness.html');
if (!existsSync(harness)) { console.error('missing frontend/_harness.html — run: bash scripts/make_harness.sh'); process.exit(2); }

let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? '  ok ' : 'FAIL ') + name + (ok || detail == null ? '' : ' — ' + detail));
  if (!ok) failures++;
}
function load(query) {
  return JSDOM.fromFile(harness, { url: pathToFileURL(harness).href + query, runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true });
}
async function until(fn, ms = 6000) {
  const t0 = Date.now();
  for (;;) { const v = fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await new Promise((r) => setTimeout(r, 50)); }
}
const tick = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (n) => (n && n.textContent || '').replace(/\s+/g, ' ').trim();

{
  const dom = await load('?view=terminal');
  const w = dom.window, d = w.document;
  await until(() => w.Board && w.Board.Terminal && w.Board.Terminal.add && w.StructsSoundCatalogue);
  const T = w.Board.Terminal, C = w.StructsSoundCatalogue;
  const calls = () => w.__HARNESS_CALLS__ || [];
  const callsFor = (cmd) => calls().filter((c) => c.cmd === cmd);

  // ── ⌘K ──
  const row = T.suggestFor('').find((o) => /\bSOUNDS\b/.test(String(o.words || '')));
  check('SOUNDS is in the palette, under System', row && row.group === 'System', JSON.stringify(row || null));
  check('…and SFX and AUDIO open the same card', T.parse('SFX').type === 'sounds' && T.parse('AUDIO').type === 'sounds' && T.parse('SOUNDS').type === 'sounds');

  // ── The card ──
  const before = callsFor('sound_mount_set').length;
  // The engine (sound.js) reads the config once at page boot; the card's own read is the next one.
  const readsBefore = callsFor('sound_config_get').length;
  const card = T.add('sounds', {}, 2);
  const id = (card && card.id) || 'sounds-1';
  const host = await until(() => {
    const c = d.querySelector('#tm-grid .tm-card[data-card="' + id + '"] .tm-body');
    return c && c.querySelector('.sd-row') ? c : null;
  });
  check('the card renders', host !== null);
  if (!host) { console.log('  (skipping the rest: nothing rendered)'); }
  else {
    check('it read the config once and switched tracing on', callsFor('sound_config_get').length === readsBefore + 1 && callsFor('sound_trace_set').some((c) => c.args && c.args.enabled === true));
    const tabs = [...host.querySelectorAll('.sui-screen-nav-item')].map(text);
    check('every catalogue group is a tab, plus the Tape', C.GROUPS.every((g) => tabs.some((t) => t.indexOf(g) === 0)) && tabs.some((t) => t.indexOf('Tape') === 0), tabs.join('|'));
    const tiles = [...host.querySelectorAll('.sd-hud .sd-tile')];
    check('the head is four readouts: master, music, sfx and the sound switch', tiles.length === 4 && text(tiles[1]).replace(/\s+/g, '') === '70%Music' && text(tiles[3]).replace(/\s+/g, '') === 'ONSound', tiles.map(text).join('|'));
    check('no stepper is open until a tile is pressed', !host.querySelector('.sd-hud-open'));
    tiles[1].click();
    check('pressing the music tile opens its typed field', host.querySelector('.sd-hud-open input[type=text]') && host.querySelector('.sd-tile[data-knob="music_volume"].is-open'));
    const card0 = d.querySelector('#tm-grid .tm-card[data-card="' + id + '"]');
    const own = [...card0.querySelectorAll('.tm-doors .tm-door-own')].map((a) => a.title);
    check('Stop all and Show sound.json are title-bar doors', own.includes('Stop all') && own.includes('Show sound.json'), own.join('|'));

    // Every mount in every group has a row.
    let missing = [];
    for (const g of C.GROUPS) {
      const tab = [...host.querySelectorAll('.sui-screen-nav-item')].find((t) => text(t).indexOf(g) === 0);
      tab.click();
      await tick(20);
      for (const m of C.MOUNTS.filter((m) => m.group === g)) {
        if (!host.querySelector('.sd-row[data-mount="' + m.id + '"]')) missing.push(m.id);
      }
    }
    check('every catalogue mount has a row in its group', missing.length === 0, missing.slice(0, 5).join(', '));

    // UI group: the mapped press shows its chip, the rest are silent.
    [...host.querySelectorAll('.sui-screen-nav-item')].find((t) => text(t).indexOf('UI') === 0).click();
    await tick(20);
    const press = host.querySelector('.sd-row[data-mount="ui.press"]');
    check('a mapped mount shows its file as a chip and its non-default setting as a mark',
      press && press.getAttribute('data-state') === 'set' && text(press.querySelector('.sd-chip-name')) === 'click.wav' && /50ms/.test(text(press)));
    const denied = host.querySelector('.sd-row[data-mount="ui.denied"]');
    check('an unmapped mount says SILENT', denied && denied.getAttribute('data-state') === 'silent' && text(denied.querySelector('.sd-chip')) === 'SILENT');
    check('nothing was written just by painting', callsFor('sound_mount_set').length === before);

    // Alerts: a file Rust could not vet carries its reason.
    [...host.querySelectorAll('.sui-screen-nav-item')].find((t) => text(t).indexOf('Alerts') === 0).click();
    await tick(20);
    const lost = host.querySelector('.sd-row[data-mount="alert.ore_received"] .sd-chip-bad');
    check('a refused file shows its reason on the chip', lost && /missing/.test(text(lost)));

    // Select the press row and step its delay: one debounced write.
    [...host.querySelectorAll('.sui-screen-nav-item')].find((t) => text(t).indexOf('UI') === 0).click();
    await tick(20);
    host.querySelector('.sd-row[data-mount="ui.press"] .sd-ident').click();
    await tick(20);
    const sel = host.querySelector('.sd-row[data-mount="ui.press"]');
    check('clicking a row selects it and opens its settings', sel && sel.classList.contains('is-selected') && sel.querySelector('.sd-settings'));
    const caps = [...sel.querySelectorAll('.sd-settings label.cfg-field > span:first-child')].map(text);
    check('six stacked fields in setting order, no steppers', caps.join('|') === 'Delay ms|Volume %|Loop|Loop count|Pick|Enabled' && !sel.querySelector('.sd-settings .sui-input-stepper'), caps.join('|'));
    const typed = sel.querySelectorAll('.sd-settings input[type=text]');
    check('delay, volume and loop count are typed fields; loop and enabled are switches', typed.length === 3 && sel.querySelectorAll('.sd-settings .sui-checkbox').length === 2 && sel.querySelector('.sd-settings select'));
    const setVal = (input, v) => { input.value = v; input.dispatchEvent(new w.Event('change', { bubbles: true })); };
    setVal(typed[0], '120'); setVal(typed[0], '150');
    await tick(400);
    const writes = callsFor('sound_mount_set').slice(before);
    check('two commits become one debounced sound_mount_set patch for that mount', writes.length === 1 && writes[0].args.id === 'ui.press' && writes[0].args.patch && writes[0].args.patch.delay_ms === 150, JSON.stringify(writes.map((c) => c.args)));
    setVal(typed[0], '999999');
    check('a value over the range is clamped in the field', typed[0].value === '60000');
    setVal(typed[0], 'abc');
    check('a non-number falls back to the catalogue default', typed[0].value === '0');
    setVal(typed[1], '80');
    await tick(400);
    check('volume is written as a fraction', callsFor('sound_mount_set').some((c) => c.args.id === 'ui.press' && c.args.patch.volume === 0.8));

    // The event repaints; the command's answer does not.
    const reads = callsFor('sound_config_get').length;
    w.__HARNESS_EMIT__('sound-config', { version: 1, master_volume: 0.5, music_volume: 0.7, sfx_volume: 1, muted: true, trace: true,
      mounts: { 'ui.press': { files: [{ name: 'click.wav', size: 1, mtime_ms: 1, ok: true }, { name: 'click-2.wav', size: 1, mtime_ms: 1, ok: true }] }, 'ui.denied': { files: [{ name: 'buzz.mp3', size: 1, mtime_ms: 1, ok: true }] } } });
    await tick(30);
    check('a sound-config event repaints the rows without another read',
      text(host.querySelector('.sd-row[data-mount="ui.denied"] .sd-chip-name')) === 'buzz.mp3' && host.querySelectorAll('.sd-row[data-mount="ui.press"] .sd-chip').length === 2 && callsFor('sound_config_get').length === reads);
    check('…and the head follows it', /MUTED/.test(text(host.querySelector('.sd-tile[data-knob="muted"]'))) && text(host.querySelector('.sd-tile[data-knob="master_volume"] .fstat-v')) === '50%');
    check('the pick is offered', host.querySelector('.sd-row[data-mount="ui.press"] .sd-settings select'));

    // Doors.
    const pressRow = host.querySelector('.sd-row[data-mount="ui.press"]');
    pressRow.querySelector('[title^="Add a file"]').click();
    await tick(20);
    check('Add a file asks Rust to pick for that mount', callsFor('sound_pick_file').some((c) => c.args.id === 'ui.press'));
    pressRow.querySelector('[title="Clear files"]').click();
    await tick(400);
    check('Clear files writes clear_files', callsFor('sound_mount_set').some((c) => c.args.id === 'ui.press' && c.args.patch.clear_files === true));
    pressRow.querySelector('.sd-chip-x').click();
    await tick(400);
    check('the × on a chip removes that file by index', callsFor('sound_mount_set').some((c) => c.args.id === 'ui.press' && c.args.patch.remove_file === 0));

    // The head writes the globals.
    host.querySelector('.sd-tile[data-knob="muted"]').click();
    await tick(20);
    check('the sound tile toggles mute through sound_config_set', callsFor('sound_config_set').some((c) => c.args.patch && c.args.patch.muted === false));
    host.querySelector('.sd-tile[data-knob="sfx_volume"]').click();
    await tick(20);
    const sfx = host.querySelector('.sd-hud-open input[type=text]');
    sfx.value = '105'; sfx.dispatchEvent(new w.Event('change', { bubbles: true }));
    await tick(20);
    check('a volume tile\'s field writes that volume', callsFor('sound_config_set').some((c) => c.args.patch && c.args.patch.sfx_volume === 1.05), JSON.stringify(callsFor('sound_config_set').map((c) => c.args.patch)));
    host.querySelector('.sd-hud-open .sd-done').click();
    check('Done closes the drawer', !host.querySelector('.sd-hud-open'));

    // The tape.
    [...host.querySelectorAll('.sui-screen-nav-item')].find((t) => text(t).indexOf('Tape') === 0).click();
    await tick(20);
    check('an empty tape says it is waiting', /Waiting for cues/.test(text(host.querySelector('.sd-tape'))));
    w.__HARNESS_EMIT__('sound-trace', { window: 'main', cues: [
      { ts_ms: 1700000000000, candidates: ['fire.tank.primary', 'fire.primary'], resolved: null, silent: true, reason: 'no-file' },
      { ts_ms: 1700000000100, candidates: ['ui.press'], resolved: 'ui.press', index: 0, file: 'click.wav', silent: false },
    ] });
    await tick(30);
    const rows = [...host.querySelectorAll('.sd-tape-row')];
    check('two cues become two rows, newest first, silent and hit told apart',
      rows.length === 2 && rows[0].classList.contains('sd-hit') && rows[1].classList.contains('sd-silent') && /fire\.tank\.primary · no-file/.test(text(rows[1])) && /main/.test(text(rows[1])));
    rows[1].querySelector('[title^="Pick a file for"]').click();
    await tick(20);
    check('the silent row\'s door picks a file for the first candidate', callsFor('sound_pick_file').some((c) => c.args.id === 'fire.tank.primary'));
    rows[1].click();
    await tick(30);
    check('clicking the row jumps to that mount, selected, in its group',
      host.querySelector('.sd-row[data-mount="fire.tank.primary"].is-selected') && /Weapons/.test(text(host.querySelector('.sui-screen-nav-item.sui-mod-active'))));

    // Unmount switches tracing off.
    T.remove(id);
    await tick(30);
    check('removing the last card switches tracing off', callsFor('sound_trace_set').some((c) => c.args && c.args.enabled === false));
  }
}

console.log(failures ? `\n${failures} failure(s)` : '\nall good');
process.exit(failures ? 1 : 0);
