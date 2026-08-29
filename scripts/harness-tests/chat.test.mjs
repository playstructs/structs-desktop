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
  check('sections are DIRECT, LOCAL NET, GALAXY NET',
    labels.join('|') === 'Direct|Local Net|Galaxy Net', labels.join('|'));

  // Only rooms you are IN. Alpha Base and Community are public but unjoined,
  // and live in Browse — a list that mixes "your channels" with "every
  // channel on the server" answers neither question.
  const rows = all(d, '.sui-result-row');
  check('only joined rooms are listed', rows.length === 4, String(rows.length));
  check('an unjoined room is not here',
    !rows.some((r) => text(r).startsWith('Alpha Base')),
    rows.map((r) => text(r)).join(' | '));

  // Grouping follows the fixture's `section`, not row order. People first.
  const groups = all(d, '.chat-net-group');
  const dmRows = groups[0].querySelectorAll('.sui-result-row');
  check('direct holds the one DM', dmRows.length === 1, String(dmRows.length));
  check('a DM is titled by the person, not the room',
    text(dmRows[0]).startsWith('JPEG'), text(dmRows[0]));
  check('a DM is subtitled by their player id',
    text(dmRows[0]).includes('PID #1-61'), text(dmRows[0]));
  check('a DM shows a portrait, not a channel glyph',
    dmRows[0].querySelectorAll('.pfp-viewer-layer').length === 5,
    String(dmRows[0].querySelectorAll('.pfp-viewer-layer').length));

  const localRows = groups[1].querySelectorAll('.sui-result-row');
  check('local net holds the one joined room', localRows.length === 1, String(localRows.length));
  check('room names render', text(localRows[0]).indexOf('Raid') === 0, text(localRows[0]));
  check('a single member is singular', text(localRows[0]).includes('1 Player'), text(localRows[0]));
  const snc = rows.find((r) => text(r).startsWith('SN.Corporation'));
  check('member count is pluralised', text(snc).includes('25 Players'), text(snc));
  check('a channel row shows its glyph, not a portrait',
    localRows[0].querySelector('.chat-room-icon') !== null);

  // Nothing here needs joining — that is what Browse is for.
  check('no JOIN buttons in your own channel list',
    all(d, '.sui-result-row button').length === 0,
    String(all(d, '.sui-result-row button').length));
  check('every listed room is clickable', all(d, '.chat-room-row').length === 4,
    String(all(d, '.chat-room-row').length));

  // Only the player's OWN guild is offered — no other guild will authenticate them.
  const nav = all(d, '#menu-page-nav-items .sui-screen-nav-item');
  check('nav lists exactly the player\'s own guild', nav.length === 1, String(nav.length));
  check('and it is marked active', nav[0].className.includes('sui-mod-active'), nav[0].className);

  // Resources are rendered VERBATIM from Rust — the window must not re-scale
  // them. "128007K/133641K" was what happened when it tried.
  const res = text(d.querySelector('.sui-page-header-resources'));
  check('energy renders on the game\'s own ladder', res.includes('128.01KW/133.64KW'), res);
  check('alpha renders on the game\'s own ladder', res.includes('9.4Kg'), res);
  check('no K-per-thousand abbreviation leaks in', !/\d+K\//.test(res), res);

}

// ── The channel directory ───────────────────────────────────────────────────
// IRC's /list: what else is out there, as opposed to where you already are.
{
  console.log('\n— browse channels');
  const { w, d } = await open();
  d.getElementById('chat-browse').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await tick();
  check('the directory icon opens Browse', w.Chat._state.view === 'browse', w.Chat._state.view);
  check('it asks the homeserver, not the local list',
    w.__HARNESS_CALLS__.some((c) => c.cmd === 'matrix_browse'));

  const rows = all(d, '.sui-result-row');
  check('every public channel is listed', rows.length === 5, String(rows.length));
  check('including ones you are already in',
    rows.some((r) => text(r).startsWith('SN.Corporation')),
    rows.map((r) => text(r)).join(' | '));
  check('a room you are in says so instead of offering Join',
    rows.find((r) => text(r).startsWith('SN.Corporation')).querySelector('.sui-badge') !== null);
  check('a room you are not in offers Join',
    rows.find((r) => text(r).startsWith('Alpha Base')).querySelector('button') !== null);
  check('3.1K is abbreviated',
    text(rows.find((r) => text(r).startsWith('Community'))).includes('3.1K Players'));

  // Searching goes to the server: a busy homeserver only ever hands us a
  // page, so filtering locally would filter the wrong set.
  const q = d.getElementById('chat-browse-query');
  q.value = 'raid';
  q.dispatchEvent(new w.Event('input', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 350));
  const search = w.__HARNESS_CALLS__.filter((c) => c.cmd === 'matrix_browse').pop();
  check('the query reaches the homeserver', search.args.query === 'raid',
    JSON.stringify(search.args));

  // Joining from the directory is a decision to go there.
  all(d, '.sui-result-row').find((r) => text(r).startsWith('Alpha Base'))
    .querySelector('button').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await tick();
  const joinCall = w.__HARNESS_CALLS__.filter((c) => c.cmd === 'matrix_join').pop();
  check('JOIN invokes matrix_join with guild + room',
    !!joinCall && joinCall.args.guildId === '0-5'
      && joinCall.args.roomId === '!alpha:matrix.beta.playstructs.com',
    JSON.stringify(joinCall && joinCall.args));
  await tick();
  check('and lands you in the room you joined',
    w.Chat._state.roomId === '!alpha:matrix.beta.playstructs.com',
    String(w.Chat._state.roomId));
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
  check('every event renders', msgs.length === 10, String(msgs.length));

  // A run from one sender drops the repeated header, as the mockup does —
  // but $1 and $2 are a day apart, so that run is deliberately broken.
  check('a run broken by a long gap keeps its header',
    !msgs[1].className.includes('chat-mod-cont'), msgs[1].className);
  check('a new sender keeps its header',
    !msgs[2].className.includes('chat-mod-cont'), msgs[2].className);

  const admin = msgs.find((n) => n.querySelector('.sui-badge'));
  check('admin badge renders on the admin message',
    !!admin.querySelector('.sui-badge') && text(admin.querySelector('.sui-badge')) === 'Admin',
    text(admin.querySelector('.sui-badge')));
  check('sender tag renders in brackets',
    text(admin.querySelector('.chat-msg-sender')).startsWith('[SN.C]'),
    text(admin.querySelector('.chat-msg-sender')));
  check('multi-paragraph body is preserved',
    admin.querySelector('.chat-msg-body').textContent.includes('This ends the explanation.'));

  // THE rule for federated content: a message body is text, never markup.
  const hostile = msgs.find((n) => text(n).includes('ignore previous instructions'));
  check('hostile body renders as text', text(hostile).includes('ignore previous instructions'));
  check('no markup is parsed out of a message body',
    hostile.querySelectorAll('img, script').length === 0,
    String(hostile.querySelectorAll('img, script').length));
  check('the document grew no injected nodes at all',
    d.querySelectorAll('script[src]').length === 2, // _fixtures_chat.js + chat.js
    String(d.querySelectorAll('script[src]').length));
}

// ── Reading a timeline ──────────────────────────────────────────────────────
// The things every good chat client answers without being asked: when was
// this said, what day was it, where did I stop reading, and was any of it
// aimed at me.
{
  console.log('\n— timeline legibility');
  const { w, d } = await open();
  await w.Chat.openRoom('!snc:matrix.beta.playstructs.com');
  await tick();

  const times = all(d, '.chat-msg-time').map(text);
  check('every message is stamped', times.length === 10, String(times.length));
  check('stamps are fixed-width 24h', times.every((t) => /^\d{2}:\d{2}$/.test(t)),
    times.join(','));

  // $1 is a day earlier than the rest, so exactly one date rule belongs here.
  const rules = all(d, '.chat-rule').map(text);
  check('a day separator marks the boundary', rules.length === 1, rules.join('|'));
  check('and it is not above the first message',
    d.querySelector('.chat-scroll').firstChild.className.includes('chat-msg'),
    d.querySelector('.chat-scroll').firstChild.className);

  // An emote is one line, IRC-style, and never repeats the name in a header.
  const emote = all(d, '.chat-msg').find((n) => text(n).includes('shrugs'));
  check('an emote renders as one line',
    emote.className.includes('chat-mod-oneline'), emote.className);
  check('…in the form * Name action',
    text(emote).startsWith('* T.Xue shrugs'), text(emote));
  check('…with no separate sender header', !emote.querySelector('.chat-msg-head'));

  // Being named is the loudest thing that happens in a chat client.
  const mention = all(d, '.chat-msg').find((n) => text(n).includes('are you seeing this'));
  check('a message naming me is marked',
    mention.className.includes('chat-mod-mention'), mention.className);
  const nearMiss = all(d, '.chat-msg').find((n) => text(n).includes('Marklifers everywhere'));
  check('a substring of my name is NOT a mention',
    !nearMiss.className.includes('chat-mod-mention'), nearMiss.className);
  check('my own messages never mention me',
    !all(d, '.chat-msg').some((n) => n.className.includes('chat-mod-mention')
      && n.querySelector('.chat-mod-self')));
}

// Matching rules, checked directly — the regex is the whole feature.
//
// This table is mirrored in Rust (matrix/client.rs, mentions_match_on_word_
// boundaries) because the rule exists twice: Rust decides whether to interrupt
// you with a notification, the window decides whether to highlight. Two
// implementations of one rule are a liability unless both are pinned here.
{
  console.log('\n— mention matching');
  const { w } = await open();
  const cases = [
    ['nothing to see', false, 'no mention at all'],
    ['Marklifer, are you seeing this?', true, 'name followed by a comma'],
    ['hey Marklifer', true, 'name at the end'],
    ['ping 1-194 please', true, 'player id counts too'],
    ['Marklifers everywhere', false, 'a longer word that starts with it'],
    ['xMarklifer', false, 'a longer word that ends with it'],
    ['1-1944 is not me', false, 'a longer id'],
    ['MARKLIFER', true, 'case does not matter'],
    ['', false, 'an empty body'],
  ];
  cases.forEach(([body, want, why]) => {
    check(why, w.Chat.mentionsMe(body) === want, JSON.stringify(body));
  });
}

// ── Where I stopped reading ─────────────────────────────────────────────────
{
  console.log('\n— unread divider');
  const { w, d } = await open();
  await w.Chat.openRoom('!snc:matrix.beta.playstructs.com');
  await tick();
  check('a first visit draws no divider',
    all(d, '.chat-rule.chat-mod-alert').length === 0);

  // Leave, miss something, come back.
  w.Chat.go('channels');
  await tick();
  w.__HARNESS_FIXTURES__.matrix_timeline = {
    room: w.__HARNESS_FIXTURES__.matrix_timeline.room,
    messages: w.__HARNESS_FIXTURES__.matrix_timeline.messages.concat([
      { event_id: '$new', sender: '@1-42:matrix.beta.playstructs.com',
        sender_name: 'Netlag', sender_tag: 'SN.C', player_id: '1-42',
        body: 'while you were out', kind: 'text', self: false, admin: false,
        ts: 1787900011000 },
    ]),
  };
  await w.Chat.openRoom('!snc:matrix.beta.playstructs.com');
  await tick();

  const alert = all(d, '.chat-rule.chat-mod-alert');
  check('coming back to new messages draws the divider', alert.length === 1,
    String(alert.length));
  check('it is labelled', text(alert[0]) === 'New', text(alert[0]));
  // It must sit ABOVE the new message, not below it.
  const after = alert[0].nextSibling;
  check('and sits directly above what was missed',
    text(after).includes('while you were out'), text(after));
}

// ── Being named while looking elsewhere ─────────────────────────────────────
{
  console.log('\n— mention badge');
  const { w, d } = await open();
  w.__HARNESS_EMIT__('matrix::timeline', {
    guild_id: '0-5', room_id: '!raid:matrix.beta.playstructs.com',
    messages: [
      { event_id: '$a', sender: '@1-9:h', sender_name: 'Scout', body: 'contact', kind: 'text', ts: 1 },
      { event_id: '$b', sender: '@1-9:h', sender_name: 'Scout', body: 'Marklifer help', kind: 'text', ts: 2 },
    ],
  });
  await tick();
  const badge = d.querySelector('.chat-room-unread');
  check('the badge counts the traffic', text(badge) === '2', text(badge));
  check('and turns warning when I was named',
    badge.className.includes('sui-mod-warning'), badge.className);

  // Traffic with no mention must stay quiet.
  w.__HARNESS_EMIT__('matrix::timeline', {
    guild_id: '0-5', room_id: '!ninja:matrix.beta.playstructs.com',
    messages: [{ event_id: '$c', sender: '@1-9:h', sender_name: 'Scout', body: 'hello', kind: 'text', ts: 3 }],
  });
  await tick();
  const quiet = all(d, '.chat-room-unread').find((b) => text(b) === '1');
  check('plain traffic stays the default colour',
    !quiet.className.includes('sui-mod-warning'), quiet.className);

  // Opening the room clears both.
  await w.Chat.openRoom('!raid:matrix.beta.playstructs.com');
  await tick();
  const raid = w.Chat._state.rooms.find((r) => r.room_id === '!raid:matrix.beta.playstructs.com');
  check('opening a room clears its unread count', raid.unread === 0, String(raid.unread));
  check('…and its mention flag', !raid.mention, String(raid.mention));
}

// ── Object references ───────────────────────────────────────────────────────
// Every noun in Structs is a `<type>-<index>` id and players talk in them, so
// a chat client that leaves them as plain text makes everyone look them up by
// hand.
{
  console.log('\n— id detection');
  const { w } = await open();
  const ids = (s) => w.Chat.idsIn(s).join(',');

  check('an id is found', ids('hitting 2-15361 now') === '2-15361');
  check('several are found in order',
    ids('2-1 and 5-2 and 1-3') === '2-1,5-2,1-3', ids('2-1 and 5-2 and 1-3'));
  check('adjacent ids both match', ids('2-1 5-2') === '2-1,5-2', ids('2-1 5-2'));
  check('duplicates collapse', ids('2-1 then 2-1') === '2-1', ids('2-1 then 2-1'));

  // THE rule. 1-194 and 1-1945 are different players, and a loose match
  // attributes one's card to the other.
  check('a longer id is not a shorter one', ids('1-1945') === '1-1945', ids('1-1945'));
  check('…and does not also yield the prefix',
    ids('1-1945').indexOf('1-194,') === -1, ids('1-1945'));
  check('an id inside a word is not an id', ids('x2-1') === '', ids('x2-1'));
  check('a trailing hyphen is not a boundary', ids('2-1-3') === '', ids('2-1-3'));

  // Plumbing types get no card — mirrors refs.rs::is_referenceable.
  check('an allocation id is ignored', ids('6-1') === '', ids('6-1'));
  check('a reactor id is ignored', ids('3-1') === '', ids('3-1'));
  check('a date is not an id', ids('2026-08') === '', ids('2026-08'));
}

{
  console.log('\n— reference cards');
  const { w, d } = await open();
  await w.Chat.openRoom('!snc:matrix.beta.playstructs.com');
  await until(() => d.querySelectorAll('.chat-ref').length > 0);

  const msg = all(d, '.chat-msg').find((n) => text(n).includes('hitting'));
  const chips = msg.querySelectorAll('.chat-id');
  check('ids are marked inline', chips.length === 4,
    Array.from(chips).map((c) => text(c)).join(','));
  check('…and 1-1945 is marked as itself, not as 1-194',
    Array.from(chips).some((c) => text(c) === '1-1945')
      && !Array.from(chips).some((c) => text(c) === '1-194'),
    Array.from(chips).map((c) => text(c)).join(','));
  check('a plumbing id is left as plain text',
    !Array.from(chips).some((c) => text(c) === '6-1'));
  check('the surrounding words survive intact',
    text(msg).includes('hitting') && text(msg).includes('not'), text(msg));

  // Only the FIRST reference opens itself. A message naming four objects would
  // otherwise bury itself under four cards.
  let cards = msg.querySelectorAll('.chat-ref');
  check('only the first reference opens itself', cards.length === 1, String(cards.length));
  check('and it is the first one named',
    text(cards[0]).includes('Shield') && text(cards[0]).includes('25'), text(cards[0]));

  // The rest are chips that open theirs.
  const openable = Array.from(msg.querySelectorAll('.chat-id.chat-mod-openable'));
  check('later references are openable', openable.length === 3, String(openable.length));
  check('the first is not a control',
    !msg.querySelector('.chat-id').className.includes('chat-mod-openable'));

  openable.find((c) => text(c) === '5-2184')
    .dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await tick();
  const opened = Array.from(
    all(d, '.chat-msg').find((n) => text(n).includes('hitting')).querySelectorAll('.chat-ref'));
  check('opening one shows its card', opened.length === 2, String(opened.length));
  check('a struct card carries the work it is doing',
    opened.some((c) => text(c).includes('Mining')),
    opened.map((c) => text(c)).join(' | '));

  // Clicking again closes it — the chip is a toggle, not a one-way door.
  all(d, '.chat-msg').find((n) => text(n).includes('hitting'))
    .querySelectorAll('.chat-id.chat-mod-openable')[0]
    .dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await tick();

  // A player card is also a way to reach them.
  const msgNow = all(d, '.chat-msg').find((n) => text(n).includes('hitting'));
  Array.from(msgNow.querySelectorAll('.chat-id.chat-mod-openable'))
    .find((c) => text(c) === '1-61')
    .dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await tick();
  const playerCard = Array.from(
    all(d, '.chat-msg').find((n) => text(n).includes('hitting')).querySelectorAll('.chat-ref'))
    .find((c) => c.querySelector('.pfp-viewer-layer'));
  check('a player card carries their portrait',
    playerCard.querySelectorAll('.pfp-viewer-layer').length === 5,
    String(playerCard.querySelectorAll('.pfp-viewer-layer').length));
  playerCard.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await tick();
  const dm = w.__HARNESS_CALLS__.filter((c) => c.cmd === 'matrix_dm').pop();
  check('clicking a player card messages them', !!dm && dm.args.playerId === '1-61',
    JSON.stringify(dm && dm.args));

  // One round trip for a message naming several things, and never a repeat
  // for an id already known.
  const lookups = w.__HARNESS_CALLS__.filter((c) => c.cmd === 'matrix_refs');
  check('ids are looked up in one batch', lookups.length === 1, String(lookups.length));
  check('an unresolvable id is not retried',
    lookups[0].args.ids.indexOf('1-1945') !== -1
      && !d.querySelector('.chat-ref') === false,
    JSON.stringify(lookups[0].args.ids));

  w.Chat.render();
  await tick();
  check('re-rendering does not re-fetch',
    w.__HARNESS_CALLS__.filter((c) => c.cmd === 'matrix_refs').length === 1);
}

// ── Opened from elsewhere in the app ────────────────────────────────────────
// Every player id in the app is a working address, so anywhere a player is
// listed can be a way to reach them. Team Ops asks; this window answers.
{
  console.log('\n— opened from elsewhere');
  const { w } = await open();
  check('the window asks what it was opened for',
    w.__HARNESS_CALLS__.some((c) => c.cmd === 'matrix_take_pending_room'));

  w.__HARNESS_EMIT__('matrix::show_room', {
    guild_id: '0-5', room_id: '!dm-jpeg:matrix.beta.playstructs.com',
  });
  await tick();
  await tick();
  check('a request opens that conversation',
    w.Chat._state.roomId === '!dm-jpeg:matrix.beta.playstructs.com',
    String(w.Chat._state.roomId));

  // A request for another network must not yank this one somewhere else.
  const stay = w.Chat._state.roomId;
  w.__HARNESS_EMIT__('matrix::show_room', {
    guild_id: '0-1', room_id: '!elsewhere:matrix.crew.oh.energy',
  });
  await tick();
  check('a request for another network is ignored',
    w.Chat._state.roomId === stay, String(w.Chat._state.roomId));
}

// ── Sending ─────────────────────────────────────────────────────────────────
{
  console.log('\n— sending');
  const { w, d } = await open();
  await w.Chat.openRoom('!snc:matrix.beta.playstructs.com');
  await tick();

  const inp = () => d.getElementById('chat-input');
  inp().value = '  copy that  ';
  d.getElementById('chat-send').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));

  // The echo is on screen before the command resolves — that is the point.
  const base = 10;
  let msgs = all(d, '.chat-msg');
  check('local echo appears immediately', msgs.length === base + 1, String(msgs.length));
  const echo = () => all(d, '.chat-msg')[base];
  check('echo is dimmed while in flight',
    echo().className.includes('chat-msg-pending'), echo().className);
  check('body is trimmed', text(echo()).includes('copy that'), text(echo()));
  check('input is cleared', inp().value === '', JSON.stringify(inp().value));

  await tick();
  const sendCall = w.__HARNESS_CALLS__.filter((c) => c.cmd === 'matrix_send').pop();
  check('matrix_send gets guild, room and body',
    !!sendCall && sendCall.args.guildId === '0-5'
      && sendCall.args.roomId === '!snc:matrix.beta.playstructs.com'
      && sendCall.args.body === 'copy that',
    JSON.stringify(sendCall && sendCall.args));
  check('echo stops being pending once accepted',
    !echo().className.includes('chat-msg-pending'));

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
    msgs.length === base + 1, String(msgs.length));
  check('the surviving copy is the server event',
    w.Chat._state.messages[base].event_id === '$sent',
    w.Chat._state.messages[base].event_id);

  // Empty input must not produce an event.
  const before = w.__HARNESS_CALLS__.filter((c) => c.cmd === 'matrix_send').length;
  inp().value = '   ';
  d.getElementById('chat-send').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await tick();
  check('whitespace-only input sends nothing',
    w.__HARNESS_CALLS__.filter((c) => c.cmd === 'matrix_send').length === before);
}

// ── The composer is a command line ──────────────────────────────────────────
// IRC's best idea: everything the window can do has a name you can type.
{
  console.log('\n— slash commands');
  const { w, d } = await open();
  await w.Chat.openRoom('!snc:matrix.beta.playstructs.com');
  await tick();
  const type = async (t) => {
    d.getElementById('chat-input').value = t;
    d.getElementById('chat-send').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await tick();
  };
  const sends = () => w.__HARNESS_CALLS__.filter((c) => c.cmd === 'matrix_send');
  const lastLine = () => text(all(d, '.chat-msg').pop());

  await type('/help');
  check('/help answers in the timeline', lastLine().includes('/me'), lastLine());
  check('…and sends nothing', sends().length === 0, String(sends().length));

  // The classic IRC embarrassment: a mistyped command arriving as chat.
  await type('/qui');
  check('an unknown command is refused, not sent',
    sends().length === 0 && lastLine().includes('No command /qui'), lastLine());

  await type('/me waves');
  const emote = sends().pop();
  check('/me sends an emote', emote.args.msgtype === 'm.emote', JSON.stringify(emote.args));
  check('…carrying only the action', emote.args.body === 'waves', emote.args.body);
  check('…and echoes locally as an emote',
    all(d, '.chat-msg').pop().className.includes('chat-mod-oneline'));

  await type('/me');
  check('/me with nothing to do is refused',
    lastLine().includes('needs something'), lastLine());

  // "//" escapes, so a message that really starts with a slash is sendable.
  await type('//not a command');
  check('a doubled slash sends a literal one',
    sends().pop().args.body === '/not a command', sends().pop().args.body);

  await type('/topic');
  check('/topic reports the topic', lastLine().includes('We know better.'), lastLine());

  await type('/who');
  check('/who lists who has spoken', lastLine().includes('Netlag'), lastLine());

  await type('/join #newbies:matrix.beta.playstructs.com');
  const join = w.__HARNESS_CALLS__.filter((c) => c.cmd === 'matrix_join').pop();
  check('/join joins by alias',
    join.args.roomId === '#newbies:matrix.beta.playstructs.com', JSON.stringify(join.args));

  await type('/msg 1-61 hello there');
  const dm = w.__HARNESS_CALLS__.filter((c) => c.cmd === 'matrix_dm').pop();
  check('/msg opens a DM with that player', dm.args.playerId === '1-61', JSON.stringify(dm.args));
  await tick();
  await tick();
  const said = sends().pop();
  check('…and delivers the message it carried',
    said.args.body === 'hello there'
      && said.args.roomId === '!dm-jpeg:matrix.beta.playstructs.com',
    JSON.stringify(said.args));

  await type('/leave');
  const left = w.__HARNESS_CALLS__.filter((c) => c.cmd === 'matrix_leave').pop();
  check('/leave leaves the room you are in', !!left, JSON.stringify(left && left.args));
  check('…and returns you to the channel list',
    w.Chat._state.view === 'channels', w.Chat._state.view);
}

// ── Tab completion ──────────────────────────────────────────────────────────
{
  console.log('\n— tab completion');
  const { w, d } = await open();
  await w.Chat.openRoom('!snc:matrix.beta.playstructs.com');
  await tick();
  const inp = () => d.getElementById('chat-input');
  const tab = (shift) => {
    inp().dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Tab', shiftKey: !!shift, bubbles: true }));
  };
  const put = (v) => {
    const n = inp();
    n.value = v;
    n.setSelectionRange(v.length, v.length);
    n.dispatchEvent(new w.Event('input', { bubbles: true }));
  };

  put('net');
  tab();
  check('a name completes from the room', inp().value === 'Netlag, ', JSON.stringify(inp().value));

  put('/jo');
  tab();
  check('a command completes too', inp().value === '/join ', JSON.stringify(inp().value));

  // Mid-sentence completion keeps the words around it.
  put('ping t.x');
  tab();
  check('completion respects the rest of the line',
    inp().value === 'ping T.Xue ', JSON.stringify(inp().value));

  // Repeated Tab cycles the matches rather than re-matching the same one.
  put('/');
  tab();
  const first = inp().value;
  tab();
  const second = inp().value;
  check('a second Tab cycles', first !== second, first + ' → ' + second);
  tab(true);
  check('Shift+Tab walks back', inp().value === first, inp().value + ' vs ' + first);

  put('zzz');
  tab();
  check('no match leaves the line alone', inp().value === 'zzz', JSON.stringify(inp().value));

  // A bare slash walks the whole command list, as IRC clients do.
  put('/');
  tab();
  check('a bare slash offers the first command', inp().value === '/me ',
    JSON.stringify(inp().value));
}

// ── Typing indicators ───────────────────────────────────────────────────────
// MSN's contribution: knowing an answer is already being written.
{
  console.log('\n— typing');
  const { w, d } = await open();
  await w.Chat.openRoom('!snc:matrix.beta.playstructs.com');
  await tick();

  check('the room shows its topic',
    text(d.querySelector('.chat-topic')) === 'We know better.',
    text(d.querySelector('.chat-topic')));
  check('nobody is typing to start with',
    d.getElementById('chat-typing').className.includes('hidden'));

  w.__HARNESS_EMIT__('matrix::typing', {
    guild_id: '0-5', room_id: '!snc:matrix.beta.playstructs.com', names: ['Netlag'],
  });
  await tick();
  check('one typist is named',
    text(d.getElementById('chat-typing')) === 'Netlag is typing…',
    text(d.getElementById('chat-typing')));

  w.__HARNESS_EMIT__('matrix::typing', {
    guild_id: '0-5', room_id: '!snc:matrix.beta.playstructs.com', names: [],
  });
  await tick();
  check('and the line clears when they stop',
    d.getElementById('chat-typing').className.includes('hidden'));

  // Phrasing, checked directly — it is the whole of the feature's surface.
  check('two are named', w.Chat.typingLine(['Ada', 'Bo']) === 'Ada and Bo are typing…');
  check('three are counted', w.Chat.typingLine(['Ada', 'Bo', 'Cy']) === '3 people are typing…');
  check('none is nothing', w.Chat.typingLine([]) === '');

  // Typing in ANOTHER room must not show here.
  w.__HARNESS_EMIT__('matrix::typing', {
    guild_id: '0-5', room_id: '!raid:matrix.beta.playstructs.com', names: ['Scout'],
  });
  await tick();
  check('another room\'s typists stay in that room',
    d.getElementById('chat-typing').className.includes('hidden'));
}

// ── Announcing that we are typing ───────────────────────────────────────────
{
  console.log('\n— outgoing typing notices');
  const { w, d } = await open();
  await w.Chat.openRoom('!snc:matrix.beta.playstructs.com');
  await tick();
  const notices = () => w.__HARNESS_CALLS__.filter((c) => c.cmd === 'matrix_typing');
  const put = (v) => {
    const n = d.getElementById('chat-input');
    n.value = v;
    n.dispatchEvent(new w.Event('input', { bubbles: true }));
  };

  put('hel');
  await tick();
  check('typing is announced once', notices().length === 1, String(notices().length));
  check('…as typing:true', notices()[0].args.typing === true, JSON.stringify(notices()[0].args));

  // Throttled: the server believes a notice for 20s, so every keystroke must
  // not put a request on the wire.
  put('hell');
  put('hello');
  await tick();
  check('further keystrokes are throttled', notices().length === 1, String(notices().length));

  // A slash command is not a message being written to the room.
  const before = notices().length;
  put('');
  await tick();
  check('clearing the box retracts it',
    notices().length === before + 1 && notices().pop().args.typing === false,
    JSON.stringify(notices().pop().args));

  put('/he');
  await tick();
  check('a command announces nothing', notices().length === before + 1,
    String(notices().length));
}

// ── The dock signal ─────────────────────────────────────────────────────────
// A count you can see without switching to the app — the oldest unread signal
// there is, and still the one that works.
{
  console.log('\n— unread badge');
  const { w } = await open();
  const badges = () => w.__HARNESS_CALLS__.filter((c) => c.cmd === 'matrix_badge');
  const last = () => badges().pop().args;

  check('an empty inbox reports zero', last().count === 0, JSON.stringify(last()));

  w.__HARNESS_EMIT__('matrix::timeline', {
    guild_id: '0-5', room_id: '!raid:matrix.beta.playstructs.com',
    messages: [{ event_id: '$a', sender: '@1-9:h', sender_name: 'Scout', body: 'contact', kind: 'text', ts: 1 }],
  });
  await tick();
  check('traffic raises the count', last().count === 1, JSON.stringify(last()));
  check('…without the mention marker', last().mention === false, JSON.stringify(last()));

  w.__HARNESS_EMIT__('matrix::timeline', {
    guild_id: '0-5', room_id: '!ninja:matrix.beta.playstructs.com',
    messages: [{ event_id: '$b', sender: '@1-9:h', sender_name: 'Scout', body: 'Marklifer?', kind: 'text', ts: 2 }],
  });
  await tick();
  check('counts add across rooms', last().count === 2, JSON.stringify(last()));
  check('and a mention anywhere raises the marker', last().mention === true,
    JSON.stringify(last()));

  // The title bar is not a hot path: an unchanged count must not re-send.
  const before = badges().length;
  w.Chat.render();
  w.Chat.render();
  await tick();
  check('an unchanged badge is not re-sent', badges().length === before,
    String(badges().length - before));

  await w.Chat.openRoom('!raid:matrix.beta.playstructs.com');
  await tick();
  check('reading a room lowers the count', last().count === 1, JSON.stringify(last()));
}

// ── Scroll anchoring ────────────────────────────────────────────────────────
// Yanking someone to the bottom because a message arrived while they were
// reading scrollback is the single most annoying thing a chat client does.
//
// jsdom has no layout, so the timeline's metrics are stubbed to describe a
// scrollable box; that is the whole input the anchoring logic reads.
{
  console.log('\n— scroll anchoring');
  const { w, d } = await open();
  await w.Chat.openRoom('!snc:matrix.beta.playstructs.com');
  await tick();

  // Make every div look like a 300px window onto 1000px of history. Stubbed on
  // the PROTOTYPE, not the node: render() replaces the timeline element, and a
  // per-instance stub would vanish with it.
  Object.defineProperty(w.HTMLDivElement.prototype, 'scrollHeight',
    { get: () => 1000, configurable: true });
  Object.defineProperty(w.HTMLDivElement.prototype, 'clientHeight',
    { get: () => 300, configurable: true });
  const shape = (scrollTop) => {
    const t = d.getElementById('chat-timeline');
    t.scrollTop = scrollTop;
    return t;
  };
  const arrive = (id, body) => {
    w.__HARNESS_EMIT__('matrix::timeline', {
      guild_id: '0-5', room_id: '!snc:matrix.beta.playstructs.com',
      messages: [{ event_id: id, sender: '@1-42:matrix.beta.playstructs.com',
        sender_name: 'Netlag', body: body, kind: 'text', ts: 1787900020000 }],
    });
  };

  // Reading scrollback: a new message must NOT move them.
  shape(120);
  arrive('$scroll1', 'while you were reading');
  await tick();
  check('a message arriving mid-scrollback does not move the reader',
    d.getElementById('chat-timeline').scrollTop === 120,
    String(d.getElementById('chat-timeline').scrollTop));

  // Already at the bottom: follow the conversation.
  shape(700);
  arrive('$scroll2', 'following along');
  await tick();
  check('but at the bottom it follows',
    d.getElementById('chat-timeline').scrollTop >= 700,
    String(d.getElementById('chat-timeline').scrollTop));

  // Your own message always wins the scroll — you just wrote it.
  shape(120);
  d.getElementById('chat-input').value = 'mine';
  d.getElementById('chat-send').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await tick();
  check('sending always scrolls to your own message',
    d.getElementById('chat-timeline').scrollTop >= 700,
    String(d.getElementById('chat-timeline').scrollTop));
}

// ── The draft survives ──────────────────────────────────────────────────────
// Rendering rebuilds the composer, so an arriving message would otherwise
// delete what you were typing. A chat window that eats your draft whenever
// someone else speaks is unusable.
{
  console.log('\n— draft preservation');
  const { w, d } = await open();
  await w.Chat.openRoom('!snc:matrix.beta.playstructs.com');
  await tick();

  const input = d.getElementById('chat-input');
  input.value = 'half a thought';
  input.focus();
  input.setSelectionRange(4, 4);

  w.__HARNESS_EMIT__('matrix::timeline', {
    guild_id: '0-5', room_id: '!snc:matrix.beta.playstructs.com',
    messages: [{ event_id: '$interrupt', sender: '@1-42:matrix.beta.playstructs.com',
      sender_name: 'Netlag', body: 'interrupting', kind: 'text', ts: 1787900010000 }],
  });
  await tick();

  const live = d.getElementById('chat-input');
  check('the message arrived', text(d.body).includes('interrupting'));
  check('the draft survived it', live.value === 'half a thought', JSON.stringify(live.value));
  check('the caret stayed put', live.selectionStart === 4, String(live.selectionStart));
  check('and focus stayed in the composer', d.activeElement === live);
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
    all(d, '#menu-page-nav-items .sui-screen-nav-item').length === 1,
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

// ── Signing in happens by itself ────────────────────────────────────────────
// The credential is the key the player is already playing with, so a Connect
// button would be a prompt with exactly one answer.
{
  console.log('\n— auto sign-in');
  const { w, d } = await open('?fixture=unauth');
  await tick();
  check('connects without being asked',
    w.__HARNESS_CALLS__.some((c) => c.cmd === 'matrix_connect' && c.args.guildId === '0-5'));
  check('there is no Connect button to press', !d.getElementById('chat-connect'));
  check('and no Sign out button either', !text(d.body).includes('Sign out'));
  check('the ladder is visible while it runs',
    w.Chat._state.view === 'connection', w.Chat._state.view);
  check('homeserver is named so the target is legible',
    text(d.querySelector('.sui-data-card-body')).includes('matrix.beta.playstructs.com'));
}

// A sign-in that succeeds must land the player in the channel list, not leave
// them looking at the plumbing.
{
  console.log('\n— auto sign-in that succeeds');
  const dom = await JSDOM.fromFile(harness, {
    url: pathToFileURL(harness).href + '?fixture=unauth',
    runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true,
    beforeParse(window) {
      // Rust stores the session before matrix_connect resolves, so status
      // reports logged-in from that moment on.
      window.__HARNESS_LOGGED_IN__ = true;
    },
  });
  const w = dom.window;
  await until(() => w.Chat && w.Chat._state.view === 'channels');
  check('ends up in the channel list', w.Chat._state.view === 'channels', w.Chat._state.view);
  check('and asks for the rooms',
    w.__HARNESS_CALLS__.some((c) => c.cmd === 'matrix_rooms'));
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

// ── Only the player's own guild ─────────────────────────────────────────────
{
  console.log('\n— own guild only');
  const { w } = await open();
  const nets = w.Chat._state.networks;
  check('exactly one network is offered', nets.length === 1, String(nets.length));
  check('it is the guild the player belongs to', nets[0].guild_id === '0-5', nets[0].guild_id);
  check('and it is the selected one', w.Chat._state.guildId === '0-5', w.Chat._state.guildId);
}

// ── Messaging any player ────────────────────────────────────────────────────
// A player's address is their player id at their own guild's homeserver, both
// public — so there is nothing to request and nothing to accept.
{
  console.log('\n— direct messages');
  const { w, d } = await open();

  d.getElementById('chat-new-message').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await tick();
  check('the + opens the people picker', w.Chat._state.view === 'people', w.Chat._state.view);
  check('it asks Rust for the directory',
    w.__HARNESS_CALLS__.some((c) => c.cmd === 'matrix_people'));

  const people = all(d, '.sui-result-row');
  check('every known player is listed', people.length === 3, String(people.length));
  check('players show their portrait',
    people[0].querySelectorAll('.pfp-viewer-layer').length === 5,
    String(people[0].querySelectorAll('.pfp-viewer-layer').length));
  check('players show tag and player id',
    text(people[0]).includes('[SN.C]') && text(people[0]).includes('PID #1-61'),
    text(people[0]));
  check('an unnamed player is still addressable',
    text(people[2]).includes('Name Redacted'), text(people[2]));

  // Typing filters through Rust rather than in the window — the directory is
  // the whole galaxy and the window only ever holds a page of it.
  const q = d.getElementById('chat-people-query');
  q.value = 'phon';
  q.dispatchEvent(new w.Event('input', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 320));
  const search = w.__HARNESS_CALLS__.filter((c) => c.cmd === 'matrix_people').pop();
  check('the query reaches Rust', search.args.query === 'phon', JSON.stringify(search.args));

  all(d, '.sui-result-row')[0].dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await tick();
  const dm = w.__HARNESS_CALLS__.filter((c) => c.cmd === 'matrix_dm').pop();
  check('picking a player opens a DM with their player id',
    !!dm && dm.args.playerId === '1-61' && dm.args.guildId === '0-5',
    JSON.stringify(dm && dm.args));
  await tick();
  check('and lands in that conversation',
    w.Chat._state.roomId === '!dm-jpeg:matrix.beta.playstructs.com',
    String(w.Chat._state.roomId));
}

// ── A sender is a player ────────────────────────────────────────────────────
{
  console.log('\n— sender identity');
  const { w, d } = await open();
  await w.Chat.openRoom('!snc:matrix.beta.playstructs.com');
  await tick();

  const msgs = all(d, '.chat-msg');
  // The name carries the game identity: guild tag and on-chain username, not
  // the self-chosen Matrix display name. Asserted structurally — the space
  // between them is a CSS gap, and jsdom does no layout to observe it.
  const who = msgs[0].querySelector('.chat-msg-sender');
  check('the sender shows their guild tag',
    text(who.querySelector('.chat-msg-tag')) === '[SN.C]',
    text(who.querySelector('.chat-msg-tag')));
  check('…and their on-chain name, as a separate element',
    who.children.length === 2 && text(who.children[1]) === 'Netlag',
    text(who));

  // Clicking a name is the shortcut for "message this player".
  check('a player sender is marked addressable',
    msgs[0].querySelector('.chat-msg-sender').className.includes('chat-mod-addressable'));
  msgs[0].querySelector('.chat-msg-sender').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await tick();
  const dm = w.__HARNESS_CALLS__.filter((c) => c.cmd === 'matrix_dm').pop();
  check('clicking a sender messages them', !!dm && dm.args.playerId === '1-42',
    JSON.stringify(dm && dm.args));

  // A sender with no player id (a bot) must not offer a DM that cannot exist.
  const bot = msgs.find((n) => !n.querySelector('.chat-mod-addressable'));
  check('a non-player sender is not addressable', !!bot);
  // No portrait belongs on the SENDER line — the art needs ~40px and would be
  // a sliver of scalp there. Reference cards are a different matter: they have
  // the room, and a player card shows the same face the roster does.
  check('no portrait is squeezed onto a sender line',
    d.querySelectorAll('.chat-msg-head .pfp-viewer-layer').length === 0,
    String(d.querySelectorAll('.chat-msg-head .pfp-viewer-layer').length));
}

console.log(failures ? `\n${failures} failing check(s)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
