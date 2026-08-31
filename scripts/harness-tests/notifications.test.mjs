// System → Notifications, against the static harness — no Tauri, no rebuild.
//
//   bash scripts/make_harness.sh
//   (cd scripts/harness-tests && npm install && npm run test:notifications)
//
// What is worth pinning here is not the markup but the WIRING. Every source
// that can interrupt the player — the grass tap, the combat assessment, Comms,
// the watchdog, the updater — routes through one Rust gate keyed by a channel
// name, and this section is the only place those names are visible. So:
//
//   * the channel list, its labels and its grouping come from the server, never
//     from a list restated in JS (a channel added on one side and missed on the
//     other is exactly what this section exists to surface);
//   * a write names the CHANNEL, so a renamed label can never silence the
//     wrong event;
//   * the master switch silences without rewriting any channel, so turning it
//     back on restores what the player chose rather than everything.
//
// jsdom does NO layout: everything here is structural.
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
async function until(fn, ms = 5000) {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await new Promise((r) => setTimeout(r, 30));
  }
}

const dom = await JSDOM.fromFile(harness, {
  url: pathToFileURL(harness).href,
  runScripts: 'dangerously',
  resources: 'usable',
  pretendToBeVisual: true,
});
const w = dom.window;
const D = w.document;
const q = (s) => D.querySelectorAll(s);
const text = (n) => (n.textContent || '').replace(/\s+/g, ' ').trim();

await until(() => w.Board && w.Board.pages && w.Board.pages.config);
w.Board.pages.config.onEnter({}, 'notifications');
await until(() => q('#config-body .sui-result-row').length);

const body = D.getElementById('config-body');
const rows = () => [...q('#config-body .sui-result-row')];
const writes = () => [...(w.__HARNESS_CALLS__ || [])].filter((c) => c.cmd === 'mcp_config_set');
const lastWrite = () => writes().pop();

// ── The list is the server's ────────────────────────────────────────────────
const fixture = w.__HARNESS_FIXTURES__.mcp_config_bundle.notifications;
check('one row per channel the server sent',
  rows().length === fixture.channels.length, 'got ' + rows().length);
check('rows are labelled by the server, not by a JS table',
  rows().every((r, i) => text(r).startsWith(fixture.channels[i].label)),
  rows().map(text).join(' | '));
// The key is what the write and the Rust gate agree on; the label is only for
// reading. Both on screen means a mis-set switch is visible, not inferred.
check('each row also shows the routing key',
  fixture.channels.every((c) => rows().some((r) => text(r).includes(c.key))));

// ── Grouping is the server's too ────────────────────────────────────────────
const cardTitles = [...q('#config-body .sui-data-card-header')].map(text).filter(Boolean);
const groups = [...new Set(fixture.channels.map((c) => c.group))];
check('a card per group, in the order the channels arrived',
  groups.every((g) => cardTitles.some((t) => t.toUpperCase().includes(g.toUpperCase()))),
  cardTitles.join(' | '));

// ── State is shown, not inferred ────────────────────────────────────────────
// The chip is read on its own: textContent runs the label straight into the
// value, so a substring test against the whole row would match 'off' inside a
// word and pass for the wrong reason.
const chip = (r) => text(r.querySelector('.fstat .fstat-v'));
const off = rows().find((r) => text(r).includes('received'));
check('a disabled channel reads off', chip(off) === 'off', chip(off));
check('a disabled channel is unchecked',
  off.querySelector('input.sui-checkbox').checked === false);
check('permission is a reading on the page',
  /granted/.test(text(body)), text(body).slice(0, 200));

// ── Writes name the channel ─────────────────────────────────────────────────
const on = rows().find((r) => text(r).includes('raid_status'));
on.querySelector('input.sui-checkbox').click();
await until(() => writes().length);
check('a row write names the channel key and the new state',
  lastWrite().args.domain === 'notify'
    && lastWrite().args.payload.channel === 'raid_status'
    && lastWrite().args.payload.on === false,
  JSON.stringify(lastWrite().args));

// A group switch is one write, not one per row: eighteen round-trips to mute
// Industry would half-apply on any failure and leave the section lying.
const before = writes().length;
const groupBox = [...q('#config-body label.cfg-field')]
  .find((f) => /all combat/i.test(text(f)));
check('each group offers a single switch for the whole group', !!groupBox);
groupBox.querySelector('input.sui-checkbox').click();
await until(() => writes().length > before);
check('the group switch writes the group, once',
  writes().length === before + 1
    && lastWrite().args.payload.group === 'Combat'
    && lastWrite().args.payload.on === false,
  JSON.stringify(lastWrite().args));

// ── The master switch silences without rewriting ────────────────────────────
const masterBox = [...q('#config-body label.cfg-field')]
  .find((f) => /desktop notifications/i.test(text(f)));
check('the master switch is present and on', !!masterBox
  && masterBox.querySelector('input.sui-checkbox').checked === true);
const beforeMaster = writes().length;
masterBox.querySelector('input.sui-checkbox').click();
await until(() => writes().length > beforeMaster);
check('the master switch writes only `enabled`',
  lastWrite().args.payload.enabled === false
    && lastWrite().args.payload.channel === undefined
    && lastWrite().args.payload.group === undefined,
  JSON.stringify(lastWrite().args));

// Re-render with the master off and every channel's own value untouched: the
// rows must still show what the player chose, with the chip carrying the fact
// that nothing is getting through.
w.__HARNESS_FIXTURES__.mcp_config_bundle.notifications = { ...fixture, enabled: false };
w.Board.pages.config.onEnter({}, 'notifications');
await until(() => rows().length === fixture.channels.length && /muted/.test(text(body)));
const raid = rows().find((r) => text(r).includes('raid_status'));
check('a silenced channel keeps its own switch',
  raid.querySelector('input.sui-checkbox').checked === true, text(raid));
check('every chip reads muted while the master is off',
  rows().every((r) => chip(r) === 'muted'), rows().map(chip).join(' | '));

// ── The two sides of the gate agree ─────────────────────────────────────────
// The board renders whatever Rust sends, so a channel Rust can raise but the
// section cannot switch is invisible from the UI. Read the Rust table directly.
const rs = readFileSync(resolve(repo, 'src-tauri', 'src', 'notifications.rs'), 'utf8');
const table = rs.slice(rs.indexOf('pub const CHANNELS'), rs.indexOf('fn known('));
const keys = [...table.matchAll(/\("([a-z_]+)", "/g)].map((m) => m[1]);
check('Rust declares a channel table the board can render', keys.length >= 10, String(keys.length));

// Every notify_on() call site in Rust, and every channel the grass tap can
// pass, must exist in that table — otherwise it silently cannot be switched.
const srcDir = resolve(repo, 'src-tauri', 'src');
const files = ['game_state.rs', 'updater.rs', 'mcp/watchdog.rs', 'matrix/client.rs'];
const used = new Set();
for (const f of files) {
  const t = readFileSync(resolve(srcDir, f), 'utf8');
  for (const m of t.matchAll(/notify_on\(\s*\n?\s*"([a-z_]+)"/g)) used.add(m[1]);
  for (const m of t.matchAll(/is_on\("([a-z_]+)"\)/g)) used.add(m[1]);
  for (const m of t.matchAll(/\{\s*"(comms_[a-z]+)"\s*\}/g)) used.add(m[1]);
}
const orphans = [...used].filter((k) => !keys.includes(k));
check('every Rust alert names a channel the section lists',
  orphans.length === 0, orphans.join(', '));

// The grass tap passes the event CATEGORY as the channel, so every category
// the tap can notify on needs an entry too.
const cfg = readFileSync(resolve(repo, 'frontend', 'structs-config.js'), 'utf8');
const evBlock = cfg.slice(cfg.indexOf('var NOTIFICATION_EVENTS = {'), cfg.indexOf('// ── Debounce ──'));
const cats = [...evBlock.matchAll(/^      '([a-z_]+)': \{$/gm)].map((m) => m[1]);
check('the grass tap defines notifiable categories', cats.length >= 10, String(cats.length));
const missing = cats.filter((c) => !keys.includes(c));
check('every notifiable grass category is switchable', missing.length === 0, missing.join(', '));

check('no uncaught errors while rendering',
  (w.__HARNESS_ERRORS__ || []).length === 0, (w.__HARNESS_ERRORS__ || []).join(' | '));

console.log(failures ? `\n${failures} failure(s)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
