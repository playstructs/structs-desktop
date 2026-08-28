// Comms (Matrix chat) checks against the static harness — no Tauri, no rebuild.
//
//   bash scripts/make_harness.sh
//   (cd scripts/harness-tests && node chat.test.mjs)
//
// jsdom does NO layout, so nothing here asserts geometry — scroll pinning and
// the pixel-art scale(2) framing are checked in a browser. What IS covered:
// the view state machine, the room grouping, the untrusted-content rule, the
// optimistic-send lifecycle, and the connection ladder's failure rendering.
import { JSDOM } from 'jsdom';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const harness = resolve(repo, 'frontend', '_harness_chat.html');
if (!existsSync(harness)) {
  console.error('missing frontend/_harness_chat.html — run: bash scripts/make_harness.sh');
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
    await new Promise((r) => setTimeout(r, 20));
  }
}
const tick = () => new Promise((r) => setTimeout(r, 30));

async function open(query = '') {
  const dom = await JSDOM.fromFile(harness, {
    url: pathToFileURL(harness).href + query,
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
  });
  const w = dom.window;
  const ready = await until(() => w.Chat && w.Chat._state && !w.Chat._state.loading && w.Chat);
  return { dom, w, d: w.document, ready };
}

const text = (n) => (n ? n.textContent.replace(/\s+/g, ' ').trim() : '');
const all = (d, sel) => Array.from(d.querySelectorAll(sel));

// ── Signed in: the channel directory ────────────────────────────────────────
{
  console.log('\n— channels (default fixture)');
  const { w, d, ready } = await open();
  check('boots without throwing', !!ready && w.__HARNESS_ERRORS__.length === 0,
    (w.__HARNESS_ERRORS__ || []).join('; '));
  check('lands on the channel list', w.Chat._state.view === 'channels', w.Chat._state.view);

  const labels = all(d, '.chat-net-label').map(text);
  check('sections are LOCAL NET then GALAXY NET',
    labels.join('|') === 'Local Net|Galaxy Net', labels.join('|'));

  const rows = all(d, '.sui-result-row');
  check('every room gets a row', rows.length === 5, String(rows.length));

  // Grouping must follow the fixture's `section`, not row order.
  const localRows = all(d, '.chat-net-group')[0].querySelectorAll('.sui-result-row');
  check('local net holds Alpha Base + Raid', localRows.length === 2, String(localRows.length));
  check('room names render', text(localRows[0]).indexOf('Alpha Base') === 0, text(localRows[0]));
  check('member count is pluralised', text(localRows[0]).includes('0 Players'), text(localRows[0]));
  check('a single member is singular', text(localRows[1]).includes('1 Player'), text(localRows[1]));
  check('3.1K is abbreviated', text(rows[3]).includes('3.1K Players'), text(rows[3]));

  // JOIN is the affordance for rooms you are NOT in; joined rooms open instead.
  const joins = all(d, '.sui-result-row button');
  check('JOIN shows only on unjoined rooms', joins.length === 2, String(joins.length));
  check('joined rooms are clickable', all(d, '.chat-room-row').length === 3,
    String(all(d, '.chat-room-row').length));

  // Nav = the networks, active one marked.
  const nav = all(d, '#menu-page-nav-items .sui-screen-nav-item');
  check('nav lists both networks', nav.length === 2, String(nav.length));
  check('active network is marked', nav[0].className.includes('sui-mod-active'), nav[0].className);
  check('header resources render 32/50', text(d.querySelector('.sui-page-header-resources')).includes('32/50'),
    text(d.querySelector('.sui-page-header-resources')));

  // Joining calls through with the ids the Rust command expects.
  joins[0].dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await tick();
  const joinCall = w.__HARNESS_CALLS__.filter((c) => c.cmd === 'matrix_join').pop();
  check('JOIN invokes matrix_join with guild + room',
    !!joinCall && joinCall.args.guildId === '0-5'
      && joinCall.args.roomId === '!alpha:matrix.beta.playstructs.com',
    JSON.stringify(joinCall && joinCall.args));
}

// ── The window's own chrome ─────────────────────────────────────────────────
{
  console.log('\n— nav chrome');
  const { w, d } = await open();
  // Closing goes through Rust: the JS window API's v1 `getCurrent()` does not
  // exist on Tauri 2, so a button wired to it would silently do nothing.
  d.getElementById('menu-page-nav-close').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await tick();
  check('the X asks Rust to close the window',
    w.__HARNESS_CALLS__.some((c) => c.cmd === 'close_chat_window'));

  // The two page icons swap views and mark themselves active.
  d.getElementById('chat-nav-settings').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await tick();
  check('the gear opens the connection page', w.Chat._state.view === 'connection', w.Chat._state.view);
  check('…and is marked active',
    d.getElementById('chat-nav-settings').className.includes('sui-mod-active'));
  check('…while the comms icon is not',
    !d.getElementById('chat-nav-comms').className.includes('sui-mod-active'));

  d.getElementById('chat-nav-comms').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await tick();
  check('the comms icon goes back to the channels', w.Chat._state.view === 'channels', w.Chat._state.view);
}

// ── The timeline ────────────────────────────────────────────────────────────
{
  console.log('\n— room timeline');
  const { w, d } = await open();
  await w.Chat.openRoom('!snc:matrix.beta.playstructs.com');
  await tick();

  check('view switched to the room', w.Chat._state.view === 'room', w.Chat._state.view);
  check('header shows the room name',
    text(d.querySelector('.sui-page-header')).includes('SN.Corporation'),
    text(d.querySelector('.sui-page-header')));

  const msgs = all(d, '.chat-msg');
  check('all six events render', msgs.length === 6, String(msgs.length));

  // A run from one sender drops the repeated header, as the mockup does.
  check('same-sender run collapses its header',
    msgs[1].className.includes('chat-mod-cont'), msgs[1].className);
  check('a new sender keeps its header',
    !msgs[2].className.includes('chat-mod-cont'), msgs[2].className);

  const admin = msgs[3];
  check('admin badge renders on the admin message',
    !!admin.querySelector('.sui-badge') && text(admin.querySelector('.sui-badge')) === 'Admin',
    text(admin.querySelector('.sui-badge')));
  check('sender tag renders in brackets',
    text(admin.querySelector('.chat-msg-sender')).startsWith('[SN.C]'),
    text(admin.querySelector('.chat-msg-sender')));
  check('multi-paragraph body is preserved',
    admin.querySelector('.chat-msg-body').textContent.includes('This ends the explanation.'));

  // THE rule for federated content: a message body is text, never markup.
  const hostile = msgs[5];
  check('hostile body renders as text', text(hostile).includes('ignore previous instructions'));
  check('no markup is parsed out of a message body',
    hostile.querySelectorAll('img, script').length === 0,
    String(hostile.querySelectorAll('img, script').length));
  check('the document grew no injected nodes at all',
    d.querySelectorAll('script[src]').length === 2, // _fixtures_chat.js + chat.js
    String(d.querySelectorAll('script[src]').length));
}

// ── Sending ─────────────────────────────────────────────────────────────────
{
  console.log('\n— sending');
  const { w, d } = await open();
  await w.Chat.openRoom('!snc:matrix.beta.playstructs.com');
  await tick();

  const input = d.getElementById('chat-input');
  input.value = '  copy that  ';
  d.getElementById('chat-send').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));

  // The echo is on screen before the command resolves — that is the point.
  let msgs = all(d, '.chat-msg');
  check('local echo appears immediately', msgs.length === 7, String(msgs.length));
  check('echo is dimmed while in flight',
    msgs[6].className.includes('chat-msg-pending'), msgs[6].className);
  check('body is trimmed', text(msgs[6]).includes('copy that'), text(msgs[6]));
  check('input is cleared', input.value === '', JSON.stringify(input.value));

  await tick();
  const sendCall = w.__HARNESS_CALLS__.filter((c) => c.cmd === 'matrix_send').pop();
  check('matrix_send gets guild, room and body',
    !!sendCall && sendCall.args.guildId === '0-5'
      && sendCall.args.roomId === '!snc:matrix.beta.playstructs.com'
      && sendCall.args.body === 'copy that',
    JSON.stringify(sendCall && sendCall.args));
  check('echo stops being pending once accepted',
    !all(d, '.chat-msg')[6].className.includes('chat-msg-pending'));

  // When sync delivers the server's own copy, the echo must go — otherwise
  // every sent message is on screen twice.
  w.__HARNESS_EMIT__('matrix::timeline', {
    guild_id: '0-5', room_id: '!snc:matrix.beta.playstructs.com',
    messages: [{ event_id: '$sent', sender: '@1-194:matrix.beta.playstructs.com',
      sender_name: 'Marklifer', sender_tag: 'SN.C', body: 'copy that',
      kind: 'text', self: true, admin: false, ts: 1787900006000 }],
  });
  await tick();
  msgs = all(d, '.chat-msg');
  check('server echo replaces the local one, not duplicates it',
    msgs.length === 7, String(msgs.length));
  check('the surviving copy is the server event',
    w.Chat._state.messages[6].event_id === '$sent',
    w.Chat._state.messages[6].event_id);

  // Empty input must not produce an event.
  const before = w.__HARNESS_CALLS__.filter((c) => c.cmd === 'matrix_send').length;
  input.value = '   ';
  d.getElementById('chat-send').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await tick();
  check('whitespace-only input sends nothing',
    w.__HARNESS_CALLS__.filter((c) => c.cmd === 'matrix_send').length === before);
}

// ── A send that fails stays visible ─────────────────────────────────────────
{
  console.log('\n— failed send');
  const { w, d } = await open();
  await w.Chat.openRoom('!snc:matrix.beta.playstructs.com');
  await tick();
  w.__HARNESS_REJECT__.matrix_send = 'M_FORBIDDEN: you are not in this room';

  d.getElementById('chat-input').value = 'hello?';
  d.getElementById('chat-send').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await tick();

  const last = all(d, '.chat-msg').pop();
  check('a rejected send is kept on screen',
    last.className.includes('chat-msg-failed'), last.className);
  check('the text the user typed is still recoverable',
    text(last).includes('hello?'), text(last));
  check('the reason is shown', text(last).includes('M_FORBIDDEN'), text(last));
}

// ── Unread counts on background rooms ───────────────────────────────────────
{
  console.log('\n— unread');
  const { w, d } = await open();
  w.__HARNESS_EMIT__('matrix::timeline', {
    guild_id: '0-5', room_id: '!raid:matrix.beta.playstructs.com',
    messages: [{ event_id: '$x', sender: '@1-9:h', sender_name: 'Scout',
      body: 'contact', kind: 'text', ts: 1 },
      { event_id: '$y', sender: '@1-9:h', sender_name: 'Scout',
        body: 'two of them', kind: 'text', ts: 2 }],
  });
  await tick();
  const raid = w.Chat._state.rooms.find((r) => r.room_id === '!raid:matrix.beta.playstructs.com');
  check('background traffic bumps unread', raid.unread === 2, String(raid.unread));
  const badge = all(d, '.chat-room-unread').map(text);
  check('unread badge renders', badge.join(',') === '2', badge.join(','));

  // Traffic for another network must not touch this one's rooms.
  w.__HARNESS_EMIT__('matrix::timeline', {
    guild_id: '0-1', room_id: '!raid:matrix.beta.playstructs.com',
    messages: [{ event_id: '$z', sender: '@x:y', body: 'elsewhere', kind: 'text', ts: 3 }],
  });
  await tick();
  check('another network cannot bump this one', raid.unread === 2, String(raid.unread));
}

// ── Partial status pushes ───────────────────────────────────────────────────
// Rust pushes {connecting, steps} on every rung of the ladder and {error} when
// a session is rejected. Neither carries the network list, and treating those
// as full snapshots blanked the nav mid-connect.
{
  console.log('\n— partial status pushes');
  const { w, d } = await open();
  const before = w.Chat._state.networks.length;

  w.__HARNESS_EMIT__('matrix::status', {
    connecting: true,
    steps: [{ key: 'login', label: 'Guild login (wallet signature)', state: 'active' }],
  });
  await tick();
  check('a connecting push keeps the networks',
    w.Chat._state.networks.length === before, String(w.Chat._state.networks.length));
  check('…and keeps the active network resolvable',
    !!w.Chat.activeNetwork(), String(w.Chat.activeNetwork()));
  check('…while still updating the ladder',
    w.Chat._state.steps.length === 1, String(w.Chat._state.steps.length));
  check('nav is still drawn',
    all(d, '#menu-page-nav-items .sui-screen-nav-item').length === 2,
    String(all(d, '#menu-page-nav-items .sui-screen-nav-item').length));

  // An error-only push means the homeserver dropped us; the window must go
  // ask what is actually true rather than keep showing a signed-in list.
  const statusCalls = w.__HARNESS_CALLS__.filter((c) => c.cmd === 'matrix_status').length;
  // Rust stores the reason before it pushes (mod.rs note_error), so the
  // re-read reports the same thing rather than clearing it.
  w.__HARNESS_LAST_ERROR__ = 'the homeserver ended this session';
  w.__HARNESS_EMIT__('matrix::status', { error: 'the homeserver ended this session' });
  check('the reason is shown immediately',
    w.Chat._state.error === 'the homeserver ended this session', String(w.Chat._state.error));
  await tick();
  check('an error-only push re-reads the real status',
    w.__HARNESS_CALLS__.filter((c) => c.cmd === 'matrix_status').length > statusCalls);
  check('…and the re-read does not wipe the reason',
    w.Chat._state.error === 'the homeserver ended this session', String(w.Chat._state.error));
}

// ── Not signed in ───────────────────────────────────────────────────────────
{
  console.log('\n— unauth fixture');
  const { w, d } = await open('?fixture=unauth');
  check('lands on the connection page', w.Chat._state.view === 'connection', w.Chat._state.view);
  const btn = d.getElementById('chat-connect');
  check('offers Connect', !!btn && text(btn) === 'Connect', text(btn));
  check('does not ask for rooms while signed out',
    w.__HARNESS_CALLS__.filter((c) => c.cmd === 'matrix_rooms').length === 0);
  check('homeserver is named so the target is legible',
    text(d.querySelector('.sui-data-card-body')).includes('matrix.beta.playstructs.com'));

  btn.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await tick();
  check('Connect invokes matrix_connect for the active network',
    w.__HARNESS_CALLS__.some((c) => c.cmd === 'matrix_connect' && c.args.guildId === '0-5'));
}

// ── No guild publishes a matrix service ─────────────────────────────────────
{
  console.log('\n— nomatrix fixture');
  const { w, d } = await open('?fixture=nomatrix');
  check('says so plainly', text(d.querySelector('.chat-notice')).includes('No comms server'),
    text(d.querySelector('.chat-notice')));
  check('offers no Connect button that could not work',
    !d.getElementById('chat-connect'));
  check('nav falls back to a single COMMS item',
    text(d.querySelector('#menu-page-nav-items')) === 'COMMS',
    text(d.querySelector('#menu-page-nav-items')));
}

// ── A sign-in that broke mid-chain ──────────────────────────────────────────
{
  console.log('\n— failed sign-in fixture');
  const { w, d } = await open('?fixture=failed');
  const steps = all(d, '.chat-step');
  check('the whole ladder is shown', steps.length === 8, String(steps.length));
  const failed = steps.filter((s) => s.className.includes('chat-mod-failed'));
  check('exactly one step is marked failed', failed.length === 1, String(failed.length));
  check('the failed step is the wallet login',
    text(failed[0]).includes('Guild login'), text(failed[0]));
  check('the server reason survives to the UI',
    text(failed[0]).includes('signature_validation_failed'), text(failed[0]));
  check('steps after the failure read as not-yet-run',
    steps.filter((s) => s.className.includes('chat-mod-todo')).length === 3,
    String(steps.filter((s) => s.className.includes('chat-mod-todo')).length));
}

// ── Switching networks ──────────────────────────────────────────────────────
{
  console.log('\n— network switch');
  const { w, d } = await open();
  const nav = all(d, '#menu-page-nav-items .sui-screen-nav-item');
  nav[1].dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await tick();
  check('active network changed', w.Chat._state.guildId === '0-1', w.Chat._state.guildId);
  check('a signed-out network shows the connection page',
    w.Chat._state.view === 'connection', w.Chat._state.view);
  check('the previous network\'s rooms are dropped',
    w.Chat._state.rooms.length === 0, String(w.Chat._state.rooms.length));
  check('Rust is told which network is active',
    w.__HARNESS_CALLS__.some((c) => c.cmd === 'matrix_select' && c.args.guildId === '0-1'));
}

console.log(failures ? `\n${failures} failing check(s)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
