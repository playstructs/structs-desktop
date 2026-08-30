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
  check('every public channel is listed', rows.length === 7, String(rows.length));
  check('including ones you are already in',
    rows.some((r) => text(r).startsWith('SN.Corporation')),
    rows.map((r) => text(r)).join(' | '));

  // ── Two rooms, one name ────────────────────────────────────────────────
  // Anyone may publish a public room under any name, so the directory can
  // legitimately show the guild's room and a forgery of it side by side. The
  // address is the only thing on the row that cannot be taken, so it has to be
  // on screen — otherwise the two rows are identical and the player picks by
  // coin flip.
  {
    const named = rows.filter((r) => text(r).indexOf('SN.Corporation') === 0);
    check('a forged room can share a display name', named.length === 2,
      String(named.length));
    const addrs = named.map((r) => text(r));
    check('…and each row still shows which room it actually is',
      addrs.some((t) => t.includes('#sn-corp-official'))
      && addrs.every((t, i) => t !== addrs[1 - i]),
      addrs.join(' | '));
  }

  // ── Portraits ──────────────────────────────────────────────────────────
  // `pfpClientRenderAttributes` is a free-form on-chain string chosen by the
  // player it depicts, so it is attacker-influenced even though it is not
  // attacker-authored. A layer index has to be a number or the frame is built
  // from a path this window never meant to request.
  {
    const frame = w.Chat._fillPfp(d.createElement('div'),
      JSON.stringify({ head: 4, neck: 2, body: 1, arms: 3, background: 1 }));
    const srcs = Array.from(frame.querySelectorAll('img')).map((i) => i.getAttribute('src'));
    check('a real portrait draws its five layers', srcs.length === 5, String(srcs.length));
    check('…all from the bundle',
      srcs.every((x) => /^img\/pfp\/[a-z]+\/pfp_[a-z]+_\d+\.png$/.test(x)), srcs.join(' '));

    for (const bad of [
      { head: '../../../../etc/passwd', neck: 1 },
      { head: 'https://evil.example/x', neck: 1 },
      { head: '4', neck: 1 },          // a string that merely looks like one
      { head: 1.5, neck: 1 },
      { head: -1, neck: 1 },
    ]) {
      const f = w.Chat._fillPfp(d.createElement('div'), JSON.stringify(bad));
      const got = Array.from(f.querySelectorAll('img')).map((i) => i.getAttribute('src'));
      check('a junk head index falls back to the placeholder rather than a path: '
        + JSON.stringify(bad.head),
        got.length === 1 && got[0] === 'img/portrait-placeholder.png', got.join(' '));
    }

    // No attributes at all is the ordinary case for anyone with no on-chain
    // identity, and it must look DIFFERENT rather than borrowed.
    const none = w.Chat._fillPfp(d.createElement('div'), null);
    check('no on-chain portrait means the placeholder, never someone else\'s',
      none.querySelector('img').getAttribute('src') === 'img/portrait-placeholder.png');
  }

  // The directory spans every guild's homeserver — the public room directory
  // is empty on all of them, so these are found by alias (discovery.rs).
  const crabla = rows.find((r) => text(r).includes('Kilgore Crabla'));
  check('another guild\'s channel is discoverable', !!crabla,
    rows.map((r) => text(r)).join(' | '));
  // Labelled because it is somewhere ELSE. Rows on your own homeserver are
  // not stamped with it — that would be noise on most of the list.
  check('…and says which server it is on',
    text(crabla).includes('crab.la'), text(crabla));
  const own = rows.find((r) => text(r).startsWith('Community'));
  check('a room on your own server is not labelled with it',
    !text(own).includes('playstructs.com'), text(own));
  check('the matrix. prefix is dropped',
    w.Chat.foreignServerLabel({ canonical_alias: '#lobby:matrix.crab.la' }) === 'crab.la',
    w.Chat.foreignServerLabel({ canonical_alias: '#lobby:matrix.crab.la' }));
  check('…and what it is for',
    text(crabla).includes('AI-native guild'), text(crabla));
  check('…and offers to join it', crabla.querySelector('button') !== null);
  // Picked by ADDRESS, not by name: the directory now contains a forgery
  // sharing this room's display name, so selecting by name here would be a
  // coin flip — the same coin flip the address exists to spare the player.
  check('a room you are in says so instead of offering Join',
    rows.find((r) => text(r).includes('#sn-corporation'))
      .querySelector('.sui-badge') !== null);
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
  check('every event renders', msgs.length === 14, String(msgs.length));

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
  check('every message is stamped', times.length === 14, String(times.length));
  check('stamps are fixed-width 24h', times.every((t) => /^\d{2}:\d{2}$/.test(t)),
    times.join(','));

  // $1 is a day earlier than the rest, so exactly one date rule belongs here.
  const rules = all(d, '.chat-rule').map(text);
  check('a day separator marks the boundary', rules.length === 1, rules.join('|'));
  // Never above the first message — the only thing above it is the scrollback
  // control, which is not part of the conversation.
  const kids = Array.from(d.querySelector('.chat-scroll').children);
  check('the log opens with the scrollback control',
    kids[0].className.includes('chat-history') || kids[0].className.includes('chat-rule'),
    kids[0].className);
  check('and no date rule sits above the first message',
    kids.findIndex((n) => n.className.includes('chat-rule') && text(n) !== 'Loading')
      > kids.findIndex((n) => n.className.includes('chat-msg')),
    kids.map((n) => n.className).join(' | '));

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
  // The scenario IS the timeline here, so pin the exact answer.
  w.__HARNESS_TIMELINE__ = {
    room: w.__HARNESS_FIXTURES__.matrix_timeline.room,
    messages: w.__HARNESS_FIXTURES__.matrix_timeline.messages.concat([
      { event_id: '$new', sender: '@1-42:matrix.beta.playstructs.com',
        sender_name: 'Netlag', sender_tag: 'SN.C', player_id: '1-42',
        body: 'while you were out', kind: 'text', self: false, admin: false,
        ts: 1787900015000 },
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
// Unread is the HOMESERVER's figure, arriving as a room-list push. It is
// maintained against the read receipts this app sends, which is what makes it
// survive the window closing and agree with the same account open elsewhere.
{
  console.log('\n— mention badge');
  const { w, d } = await open();
  const push = (counts) => {
    w.__HARNESS_EMIT__('matrix::rooms', {
      guild_id: '0-5',
      rooms: w.__HARNESS_FIXTURES__.matrix_rooms.rooms.map((r) =>
        Object.assign({}, r, counts[r.room_id] || {})),
    });
    return tick();
  };

  await push({
    '!raid:matrix.beta.playstructs.com': { unread: 2, mention: true },
    '!ninja:matrix.beta.playstructs.com': { unread: 1, mention: false },
  });
  const badge = d.querySelector('.chat-room-unread');
  check('the badge shows what the server says is unread', text(badge) === '2',
    text(badge));
  check('and turns warning when I was named',
    badge.className.includes('sui-mod-warning'), badge.className);

  const quiet = all(d, '.chat-room-unread').find((b) => text(b) === '1');
  check('plain traffic stays the default colour',
    !quiet.className.includes('sui-mod-warning'), quiet.className);

  // Messages arriving is NOT a second source of truth. The sync that
  // delivered them also carried the server's count; adding to it here as well
  // double-counted every message.
  w.__HARNESS_EMIT__('matrix::timeline', {
    guild_id: '0-5', room_id: '!raid:matrix.beta.playstructs.com',
    messages: [
      { event_id: '$a', sender: '@1-9:h', sender_name: 'Scout', body: 'contact', kind: 'text', ts: 1 },
      { event_id: '$b', sender: '@1-9:h', sender_name: 'Scout', body: 'Marklifer help', kind: 'text', ts: 2 },
    ],
  });
  await tick();
  const still = w.Chat._state.rooms.find(
    (r) => r.room_id === '!raid:matrix.beta.playstructs.com');
  check('arriving messages do not add to the server count', still.unread === 2,
    String(still.unread));

  // Read somewhere else — on a phone, say. The server says zero, and this
  // window has to believe it rather than keeping its own tally alive.
  await push({ '!raid:matrix.beta.playstructs.com': { unread: 0, mention: false } });
  const cleared = w.Chat._state.rooms.find(
    (r) => r.room_id === '!raid:matrix.beta.playstructs.com');
  check('reading elsewhere clears it here', cleared.unread === 0 && !cleared.mention,
    cleared.unread + '/' + cleared.mention);

  // Opening a room clears it locally at once — the receipt is in flight, and
  // a stale server count must not flash a badge on the room being read.
  await push({ '!raid:matrix.beta.playstructs.com': { unread: 9, mention: true } });
  await w.Chat.openRoom('!raid:matrix.beta.playstructs.com');
  await tick();
  const raid = w.Chat._state.rooms.find((r) => r.room_id === '!raid:matrix.beta.playstructs.com');
  check('opening a room clears its unread count', raid.unread === 0, String(raid.unread));
  check('…and its mention flag', !raid.mention, String(raid.mention));

  // …and a push that still carries the old count must not undo that.
  await push({ '!raid:matrix.beta.playstructs.com': { unread: 9, mention: true } });
  const open2 = w.Chat._state.rooms.find((r) => r.room_id === '!raid:matrix.beta.playstructs.com');
  check('a stale count cannot re-badge the room on screen',
    open2.unread === 0 && !open2.mention, open2.unread + '/' + open2.mention);
}

// ── Object references ───────────────────────────────────────────────────────
// Every noun in Structs is a `<type>-<index>` id and players talk in them, so
// a chat client that leaves them as plain text makes everyone look them up by
// hand.
{
  console.log('\n— id detection');
  const { w } = await open();
  // refIdsIn is what BOTH the inline marking and the cards use — testing a
  // second detector would be testing something the window does not run.
  const ids = (s) => w.Chat.refIdsIn(s).join(',');

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
  check('a provider id IS referenced', ids('10-1') === '10-1', ids('10-1'));
  // The set exists in Rust too. Adding a type in one place and not the other
  // means the id is marked but never carded, or carded but never marked.
  check('the referenceable set matches Rust',
    Object.keys(w.Chat.REF_KINDS).map(Number).sort((a, b) => a - b).join(',')
      === '0,1,2,4,5,9,10',
    Object.keys(w.Chat.REF_KINDS).join(','));
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

  // Design contract: ONE frame per card, typed by a class. The card used to
  // nest a bordered header, a bordered fact table and bordered buttons inside
  // a bordered card — four rectangles arguing about one small summary.
  check('a card is typed by its kind',
    cards[0].className.includes('chat-kind-planet'), cards[0].className);
  check('…and is a single frame, not nested data-cards',
    cards[0].querySelectorAll('.sui-data-card').length === 0);
  check('facts are a grid, not a bordered table',
    cards[0].querySelector('.chat-ref-facts') !== null);


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
  // The layers are a fixed 72px crop positioned by main.css; the FRAME does
  // the cropping. Wrapping them in a smaller box of our own clipped the clip
  // and cut every portrait off-centre.
  check('…in the roster\'s own frame',
    playerCard.querySelector('.sui-result-row-portrait-image') !== null);
  check('…with nothing nested inside it',
    playerCard.querySelectorAll('.sui-result-row-portrait-image').length === 1,
    String(playerCard.querySelectorAll('.sui-result-row-portrait-image').length));
  // A card is not a single button any more — it offers named actions.
  const actions = Array.from(playerCard.querySelectorAll('.chat-ref-action'))
    .map((b) => text(b));
  check('a player card offers what the player has',
    actions.join(',') === 'Planet,Fleet,Message,Pay', actions.join(','));

  Array.from(playerCard.querySelectorAll('.chat-ref-action'))
    .find((b) => text(b) === 'Message')
    .dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await tick();
  const dm = w.__HARNESS_CALLS__.filter((c) => c.cmd === 'matrix_dm').pop();
  check('Message opens a DM with them', !!dm && dm.args.playerId === '1-61',
    JSON.stringify(dm && dm.args));

  // Paying someone is a hand-off, not a payment. Comms has no authority to
  // spend, so the button must call the hand-off and pass ONLY the player id —
  // the destination address is resolved from the chain on the other side.
  Array.from(playerCard.querySelectorAll('.chat-ref-action'))
    .find((b) => text(b) === 'Pay')
    .dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await tick();
  const pay = w.__HARNESS_CALLS__.filter((c) => c.cmd === 'matrix_open_transfer').pop();
  check('Pay hands the transfer to Team Ops',
    !!pay && pay.args.playerId === '1-61', JSON.stringify(pay && pay.args));
  check('…passing the id and nothing else',
    !!pay && Object.keys(pay.args).length === 1, JSON.stringify(pay && pay.args));
  check('…and Comms never calls the executing command',
    !w.__HARNESS_CALLS__.some((c) => c.cmd === 'mcp_transfer_execute'));
  check('…telling the player where to finish it',
    /Team Ops/.test(text(playerCard)), text(playerCard).slice(-80));

  // Watching opens the SAME spectator window Team Ops opens.
  Array.from(playerCard.querySelectorAll('.chat-ref-action'))
    .find((b) => text(b) === 'Planet')
    .dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await tick();
  const watch = w.__HARNESS_CALLS__.filter((c) => c.cmd === 'mcp_raid_view_open').pop();
  check('Planet opens the map viewer for their planet',
    !!watch && watch.args.planetId === '2-223' && watch.args.fleetId === null,
    JSON.stringify(watch && watch.args));

  Array.from(playerCard.querySelectorAll('.chat-ref-action'))
    .find((b) => text(b) === 'Fleet')
    .dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await tick();
  const wf = w.__HARNESS_CALLS__.filter((c) => c.cmd === 'mcp_raid_view_open').pop();
  check('Fleet opens it for their fleet',
    !!wf && wf.args.fleetId === '9-61' && wf.args.planetId === null,
    JSON.stringify(wf && wf.args));

  // The portrait is the shortest path to the same place.
  playerCard.querySelector('.chat-ref-portrait')
    .dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await tick();
  check('the portrait watches their planet too',
    w.__HARNESS_CALLS__.filter((c) => c.cmd === 'mcp_raid_view_open').pop()
      .args.planetId === '2-223');

  // One round trip for a message naming several things, and never a repeat
  // for an id already known.
  const lookups = w.__HARNESS_CALLS__.filter((c) => c.cmd === 'matrix_refs');
  check('ids are looked up in one batch', lookups.length === 1, String(lookups.length));
  // An id the chain does not know is asked about ONCE and then left alone —
  // never retried on every repaint.
  check('an unresolvable id is asked about',
    lookups[0].args.ids.indexOf('1-1945') !== -1, JSON.stringify(lookups[0].args.ids));
  check('…and gets no card', !msg.querySelector('.chat-ref[data-id="1-1945"]'));

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

// ── Pictures ────────────────────────────────────────────────────────────────
// Live rooms carry images. The client used to print the filename and nothing
// else, which is the least useful possible rendering of a picture.
{
  console.log('\n— images');
  const { w, d } = await open();
  await w.Chat.openRoom('!snc:matrix.beta.playstructs.com');
  await until(() => d.querySelector('.chat-image img') !== null, 3000);

  const box = d.querySelector('.chat-image');
  check('a picture renders as a picture', !!box);
  check('…fetched through Rust, which holds the token',
    w.__HARNESS_CALLS__.some((c) => c.cmd === 'matrix_media'
      && c.args.mxc === 'mxc://matrix.beta.playstructs.com/abc123'),
    JSON.stringify(w.__HARNESS_CALLS__.filter((c) => c.cmd === 'matrix_media').map((c) => c.args)));

  const img = box.querySelector('img');
  check('…as bytes, not a URL the webview cannot authenticate',
    img.src.indexOf('data:image/') === 0, img.src.slice(0, 40));
  check('the filename survives as alt text', img.alt === 'raid-map.gif', img.alt);
  // The box is sized from the event before the bytes land, so the log does
  // not jump underneath the reader.
  check('the frame is reserved from the event\'s own dimensions',
    box.style.width === '320px' && box.style.aspectRatio.replace(/\s/g, '') === '480/480',
    box.style.width + ' ' + box.style.aspectRatio);

  // One fetch per picture, however many times the timeline repaints.
  const before = w.__HARNESS_CALLS__.filter((c) => c.cmd === 'matrix_media').length;
  w.Chat.render(); w.Chat.render();
  await tick();
  check('a repaint does not re-download it',
    w.__HARNESS_CALLS__.filter((c) => c.cmd === 'matrix_media').length === before,
    String(w.__HARNESS_CALLS__.filter((c) => c.cmd === 'matrix_media').length - before));
}

{
  console.log('\n— a refused image says so');
  const { w, d } = await open();
  w.__HARNESS_REJECT__.matrix_media = 'refusing to render image/svg+xml';
  await w.Chat.openRoom('!snc:matrix.beta.playstructs.com');
  await until(() => d.querySelector('.chat-image-failed') !== null, 3000);
  check('a refused picture reports in place, not as an empty frame',
    text(d.querySelector('.chat-image-failed')).includes('svg'),
    text(d.querySelector('.chat-image-failed')));
}

// ── Sending a mention ───────────────────────────────────────────────────────
// Reading `m.mentions` is only half of it. A message typed here that names
// somebody has to NOTIFY them, or it reaches their client as ordinary text.
{
  console.log('\n— outgoing mentions');
  const { w, d } = await open();
  await w.Chat.openRoom('!snc:matrix.beta.playstructs.com');
  await tick();
  const send = async (t) => {
    d.getElementById('chat-input').value = t;
    d.getElementById('chat-send').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await tick();
    return w.__HARNESS_CALLS__.filter((c) => c.cmd === 'matrix_send').pop();
  };

  let call = await send('@Netlag are you there');
  check('a named person is carried as a mention',
    call.args.mentions.length === 1, JSON.stringify(call.args.mentions));
  check('…with the Matrix id that will notify them',
    call.args.mentions[0].user_id === '@1-42:matrix.beta.playstructs.com',
    JSON.stringify(call.args.mentions[0]));
  check('…and the body is unchanged',
    call.args.body === '@Netlag are you there', call.args.body);

  call = await send('nobody in particular');
  check('an ordinary message mentions nobody',
    call.args.mentions.length === 0, JSON.stringify(call.args.mentions));

  // A name that is a prefix of another must not match the wrong person.
  call = await send('@T.Xue and @Netlag both');
  check('two names are both carried', call.args.mentions.length === 2,
    JSON.stringify(call.args.mentions.map((m) => m.name)));

  // Matching is on the address book, not on anything that looks like a handle.
  call = await send('@nosuchperson hello');
  check('an unknown handle is not invented',
    call.args.mentions.length === 0, JSON.stringify(call.args.mentions));

  // Checked directly — the matcher is the whole feature.
  check('a name inside a longer one is not a match',
    w.Chat.mentionsIn('@Netlagger').length === 0,
    JSON.stringify(w.Chat.mentionsIn('@Netlagger')));
  check('punctuation ends a name',
    w.Chat.mentionsIn('@Netlag, hi').length === 1,
    JSON.stringify(w.Chat.mentionsIn('@Netlag, hi')));
  check('case does not matter',
    w.Chat.mentionsIn('@netlag hi').length === 1,
    JSON.stringify(w.Chat.mentionsIn('@netlag hi')));
}

// ── Who is here ─────────────────────────────────────────────────────────────
{
  console.log('\n— member list');
  const { w, d } = await open();
  await w.Chat.openRoom('!snc:matrix.beta.playstructs.com');
  await tick();

  d.getElementById('chat-room-people').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await tick();
  check('the room header opens the member list',
    w.Chat._state.view === 'members', w.Chat._state.view);
  check('it asks Rust who is in THIS room',
    w.__HARNESS_CALLS__.some((c) => c.cmd === 'matrix_members'
      && c.args.roomId === '!snc:matrix.beta.playstructs.com'));

  const rows = all(d, '.sui-result-row');
  check('everyone is listed', rows.length === 3, String(rows.length));
  check('a player shows their portrait',
    rows[0].querySelectorAll('.pfp-viewer-layer').length === 5,
    String(rows[0].querySelectorAll('.pfp-viewer-layer').length));
  check('…and you are marked as you', text(rows[0]).includes('(you)'), text(rows[0]));
  // A bot is not a person and must not pretend to be one.
  const bot = rows.find((r) => text(r).includes('SN Corp Bot'));
  check('a bot gets a glyph, not a portrait',
    bot.querySelector('.chat-room-icon') !== null
      && bot.querySelectorAll('.pfp-viewer-layer').length === 0);
  check('…and cannot be messaged', bot.querySelector('button') === null);

  const jpeg = rows.find((r) => text(r).includes('JPEG'));
  check('another player can be messaged', jpeg.querySelector('button') !== null);
  jpeg.querySelector('button').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await tick();
  const dm = w.__HARNESS_CALLS__.filter((c) => c.cmd === 'matrix_dm').pop();
  check('…and messaging them uses their player id',
    !!dm && dm.args.playerId === '1-61', JSON.stringify(dm && dm.args));

  // Back goes to the conversation, not out to the channel list.
  const { w: w2, d: d2 } = await open();
  await w2.Chat.openRoom('!snc:matrix.beta.playstructs.com');
  await tick();
  w2.Chat.go('members');
  await tick();
  d2.querySelector('.sui-page-header .sui-nav-btn')
    .dispatchEvent(new w2.MouseEvent('click', { bubbles: true }));
  await tick();
  check('back returns to the room', w2.Chat._state.view === 'room', w2.Chat._state.view);
}

// ── Exact mentions ──────────────────────────────────────────────────────────
// `m.mentions` is the sender saying who they meant. It is exact, and it works
// when the body does not contain the name at all.
{
  console.log('\n— m.mentions');
  const { w, d } = await open();
  await w.Chat.openRoom('!snc:matrix.beta.playstructs.com');
  await tick();

  const aimed = all(d, '.chat-msg').find((n) => text(n).includes('you around?'));
  check('a declared mention is marked',
    aimed.className.includes('chat-mod-mention'), aimed.className);
  check('…even though the body never says my name',
    !text(aimed).includes('Marklifer') && w.Chat.mentionsMe('you around?') === false,
    text(aimed));

  // The ROOM badge is a different question, and no longer this window's to
  // answer: the homeserver's push rules already understand `m.mentions`, and
  // its `highlight_count` is what lights the badge. See the mention-badge
  // block. What is tested here is the per-message marking, which is the one
  // part the window still decides.
  const plain = all(d, '.chat-msg').find((n) => text(n).includes('hitting 2-15361'));
  check('a message that names nobody is not marked',
    plain && !plain.className.includes('chat-mod-mention'), plain && plain.className);
}

// ── Links ───────────────────────────────────────────────────────────────────
// A link in a chat message is written by a stranger, so the destination is the
// only part worth trusting and it opens in the system browser, never in-app.
{
  console.log('\n— links');
  const { w, d } = await open();
  await w.Chat.openRoom('!snc:matrix.beta.playstructs.com');
  await tick();

  const msg = all(d, '.chat-msg').find((n) => text(n).includes('playstructs.com/docs'));
  const links = Array.from(msg.querySelectorAll('.chat-link'));
  check('http links are marked', links.length === 2,
    links.map((l) => text(l)).join(' | '));

  // "see https://example.com." must not open ".com." — the full stop is the
  // sentence, not the link.
  check('trailing punctuation is not part of the link',
    text(links[0]) === 'https://playstructs.com/docs', text(links[0]));
  check('and the tooltip carries the real destination',
    links[0].title === 'https://playstructs.com/docs', links[0].title);

  // Only http/https are even offered; Rust refuses the rest, but not offering
  // it is the better half of that.
  check('a javascript: scheme is not a link',
    !links.some((l) => text(l).indexOf('javascript:') === 0),
    links.map((l) => text(l)).join(' | '));
  check('…and survives as plain text', text(msg).includes('javascript:alert(1)'));

  // An id inside a URL is part of the URL, not a reference — and that answer
  // has to hold for the CARD too. Marking and carding using different rules
  // produced a card with no visible chip to explain it.
  check('an id inside a link is not marked as a reference',
    !Array.from(msg.querySelectorAll('.chat-id')).some((c) => text(c) === '2-15361'),
    Array.from(msg.querySelectorAll('.chat-id')).map((c) => text(c)).join(','));
  check('…and gets no card either', msg.querySelector('.chat-ref') === null);
  check('the two rules agree', w.Chat.refIdsIn(
    'see https://beta.playstructs.com/planet/2-15361 and 5-1').join(',') === '5-1');

  links[0].dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await tick();
  const opened = w.__HARNESS_CALLS__.filter((c) => c.cmd === 'matrix_open_url').pop();
  check('clicking asks Rust to open it externally',
    !!opened && opened.args.url === 'https://playstructs.com/docs',
    JSON.stringify(opened && opened.args));

  // Nothing in a message may navigate the window itself.
  check('no anchor carries a real href',
    !Array.from(d.querySelectorAll('.chat-msg a[href]'))
      .some((a) => a.getAttribute('href') !== 'javascript:void(0)'));
}

// ── Read markers ────────────────────────────────────────────────────────────
{
  console.log('\n— read markers');
  const { w, d } = await open();
  await w.Chat.openRoom('!snc:matrix.beta.playstructs.com');
  await tick();
  const marks = () => w.__HARNESS_CALLS__.filter((c) => c.cmd === 'matrix_mark_read');

  check('reading a room tells the homeserver', marks().length >= 1, String(marks().length));
  check('…up to the newest event', marks().pop().args.eventId === '$14',
    JSON.stringify(marks().pop().args));

  // render() runs constantly; the homeserver does not need to hear it twice.
  const before = marks().length;
  w.Chat.render();
  w.Chat.render();
  await tick();
  check('an unchanged position is not re-sent', marks().length === before,
    String(marks().length - before));

  // A local echo has no server event id and would be a 400.
  d.getElementById('chat-input').value = 'mine';
  d.getElementById('chat-send').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await tick();
  check('a local echo is never marked',
    marks().every((c) => String(c.args.eventId).charAt(0) === '$'),
    marks().map((c) => c.args.eventId).join(','));
}

// ── /whois ──────────────────────────────────────────────────────────────────
{
  console.log('\n— whois');
  const { w, d } = await open();
  await w.Chat.openRoom('!snc:matrix.beta.playstructs.com');
  await tick();
  d.getElementById('chat-input').value = '/whois 1-61';
  d.getElementById('chat-send').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await tick();
  await tick();

  const last = all(d, '.chat-msg').pop();
  check('the answer carries the player card',
    last.querySelector('.chat-ref') !== null);
  check('…with their name and holdings',
    text(last).includes('JPEG') && text(last).includes('9.4Kg'), text(last));
  check('and nothing was sent to the room',
    !w.__HARNESS_CALLS__.some((c) => c.cmd === 'matrix_send' && /whois/.test(c.args.body)));

  d.getElementById('chat-input').value = '/whois';
  d.getElementById('chat-send').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await tick();
  check('and it asks for a player when given none',
    text(all(d, '.chat-msg').pop()).includes('needs a player id'),
    text(all(d, '.chat-msg').pop()));
}

// ── Renting capacity from a card ────────────────────────────────────────────
// A provider is an offer; the point of putting it in the conversation is to be
// able to close it there. It is also a PURCHASE, so the quote comes first.
{
  console.log('\n— provider agreements');
  const { w, d } = await open();
  await w.Chat.openRoom('!snc:matrix.beta.playstructs.com');
  await until(() => d.querySelectorAll('.chat-ref').length > 0);

  const msg = all(d, '.chat-msg').find((n) => text(n).includes('renting from'));
  const card = msg.querySelector('.chat-ref');
  check('a provider gets a card', !!card, text(msg));
  check('…priced in the provider\'s own denom',
    text(card).includes('1 ack / W / block'), text(card));

  const rent = Array.from(card.querySelectorAll('.chat-ref-action'))
    .find((b) => text(b) === 'Rent capacity');
  check('…and offers to rent', !!rent);
  rent.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await tick();

  const form = card.querySelector('.chat-rent');
  check('the form opens in the card', !!form);
  const cap = form.querySelector('#rent-capacityw');
  const dur = form.querySelector('#rent-durationblocks');
  check('it starts at the provider\'s minimums',
    cap.value === '1000' && dur.value === '100', cap.value + '/' + dur.value);

  // The cost is the whole thing, debited at open — so it is stated before the
  // button that spends it.
  const quote = () => text(form.querySelector('.chat-rent-quote'));
  check('the quote prices the minimums', quote().includes('100K') && quote().includes('ack'),
    quote());
  cap.value = '2000';
  cap.dispatchEvent(new w.Event('input', { bubbles: true }));
  check('and re-prices as you type', quote().includes('200K'), quote());

  cap.value = '0';
  cap.dispatchEvent(new w.Event('input', { bubbles: true }));
  const confirm = Array.from(form.querySelectorAll('.sui-screen-btn'))
    .find((b) => text(b) === 'Confirm');
  check('a zero order cannot be confirmed', confirm.disabled === true);

  cap.value = '5000';
  cap.dispatchEvent(new w.Event('input', { bubbles: true }));
  confirm.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await tick();
  const tx = w.__HARNESS_CALLS__.filter((c) => c.cmd === 'matrix_agreement_open').pop();
  check('confirming sends the numbers on screen',
    !!tx && tx.args.providerId === '10-1' && tx.args.capacity === 5000
      && tx.args.duration === 100,
    JSON.stringify(tx && tx.args));
  check('and the card reports the result',
    text(card).includes('Agreement opened') && text(card).includes('ABCD1234'),
    text(card));
  check('…with the form closed', !card.querySelector('.chat-rent'));
}

// ── Room events are not conversation ────────────────────────────────────────
{
  console.log('\n— room events');
  const { w, d } = await open();
  await w.Chat.openRoom('!snc:matrix.beta.playstructs.com');
  await tick();

  w.__HARNESS_EMIT__('matrix::timeline', {
    guild_id: '0-5', room_id: '!snc:matrix.beta.playstructs.com',
    messages: [
      { event_id: '$e1', sender: '@1-42:matrix.beta.playstructs.com',
        sender_name: 'Netlag', body: 'joined', kind: 'event', ts: 1787900020000 },
      { event_id: '$e2', sender: '@1-77:matrix.beta.playstructs.com',
        sender_name: 'T.Xue', body: 'left', kind: 'event', ts: 1787900021000 },
    ],
  });
  await tick();

  const events = all(d, '.chat-event');
  check('events render as their own compact line', events.length === 2,
    String(events.length));
  check('naming who did it',
    text(events[0].querySelector('.chat-event-who')) === 'Netlag',
    text(events[0].querySelector('.chat-event-who')));
  check('…and what they did',
    text(events[0].querySelector('.chat-event-what')) === 'joined',
    text(events[0].querySelector('.chat-event-what')));
  check('…and carrying their own time',
    /\d{2}:\d{2}/.test(text(events[0].querySelector('.chat-event-time'))),
    text(events[0]));
  // They are not messages: no sender header, no body block, no mention rail.
  check('an event is not a message', events[0].querySelector('.chat-msg-head') === null);
  check('and does not count as one',
    all(d, '.chat-msg').every((m) => !text(m).endsWith('joined')));
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
  const base = 14;
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

  // A completed name becomes `@Name` — the convention, and what makes the
  // message carry a real mention when it is sent.
  put('net');
  tab();
  check('a name completes to an @mention', inp().value === '@Netlag ', JSON.stringify(inp().value));
  put('@net');
  tab();
  check('…and completes the same with the @ already typed',
    inp().value === '@Netlag ', JSON.stringify(inp().value));

  put('/jo');
  tab();
  check('a command completes too', inp().value === '/join ', JSON.stringify(inp().value));

  // Mid-sentence completion keeps the words around it.
  put('ping t.x');
  tab();
  check('completion respects the rest of the line',
    inp().value === 'ping @T.Xue ', JSON.stringify(inp().value));

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

// Leaving a room mid-sentence must retract in the room you LEFT. Retracting
// against the current room would leave you shown as typing, for twenty
// seconds, somewhere you are no longer looking.
{
  console.log('\n— typing follows you out of a room');
  const { w, d } = await open();
  await w.Chat.openRoom('!snc:matrix.beta.playstructs.com');
  await tick();
  const notices = () => w.__HARNESS_CALLS__.filter((c) => c.cmd === 'matrix_typing');

  const n = d.getElementById('chat-input');
  n.value = 'half a thought';
  n.dispatchEvent(new w.Event('input', { bubbles: true }));
  await tick();
  check('typing is announced in the room you are in',
    notices().pop().args.roomId === '!snc:matrix.beta.playstructs.com',
    JSON.stringify(notices().pop().args));

  await w.Chat.openRoom('!raid:matrix.beta.playstructs.com');
  await tick();
  const retraction = notices().filter((c) => c.args.typing === false).pop();
  check('leaving retracts it', !!retraction, JSON.stringify(retraction && retraction.args));
  check('…in the room you left, not the one you arrived at',
    retraction.args.roomId === '!snc:matrix.beta.playstructs.com',
    retraction.args.roomId);

  // And going back to the channel list retracts too.
  const before = notices().filter((c) => c.args.typing === false).length;
  const m = d.getElementById('chat-input');
  m.value = 'again';
  m.dispatchEvent(new w.Event('input', { bubbles: true }));
  await tick();
  w.Chat.go('channels');
  await tick();
  check('leaving for the channel list also retracts',
    notices().filter((c) => c.args.typing === false).length === before + 1,
    String(notices().filter((c) => c.args.typing === false).length - before));
}

// ── The dock signal ─────────────────────────────────────────────────────────
// A count you can see without switching to the app — the oldest unread signal
// there is, and still the one that works.
{
  console.log('\n— unread badge');
  const { w } = await open();
  const badges = () => w.__HARNESS_CALLS__.filter((c) => c.cmd === 'matrix_badge');
  const last = () => badges().pop().args;

  const push = (counts) => {
    w.__HARNESS_EMIT__('matrix::rooms', {
      guild_id: '0-5',
      rooms: w.__HARNESS_FIXTURES__.matrix_rooms.rooms.map((r) =>
        Object.assign({}, r, counts[r.room_id] || {})),
    });
    return tick();
  };

  check('an empty inbox reports zero', last().count === 0, JSON.stringify(last()));

  await push({ '!raid:matrix.beta.playstructs.com': { unread: 1 } });
  check('traffic raises the count', last().count === 1, JSON.stringify(last()));
  check('…without the mention marker', last().mention === false, JSON.stringify(last()));

  await push({
    '!raid:matrix.beta.playstructs.com': { unread: 1 },
    '!ninja:matrix.beta.playstructs.com': { unread: 1, mention: true },
  });
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

// ── Scrollback ──────────────────────────────────────────────────────────────
// A chat log that only goes back as far as the sync window is not a log.
{
  console.log('\n— scrollback');
  const { w, d } = await open();
  await w.Chat.openRoom('!snc:matrix.beta.playstructs.com');
  await tick();

  check('the log says more exists', !!d.getElementById('chat-load-earlier'));
  const before = all(d, '.chat-msg').length;

  d.getElementById('chat-load-earlier').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await tick();
  const call = w.__HARNESS_CALLS__.filter((c) => c.cmd === 'matrix_backfill').pop();
  check('it asks Rust for a page',
    !!call && call.args.roomId === '!snc:matrix.beta.playstructs.com',
    JSON.stringify(call && call.args));

  const after = all(d, '.chat-msg');
  check('older messages are prepended', after.length === before + 1,
    before + ' → ' + after.length);
  check('…above everything else', text(after[0]).includes('earlier than the rest'),
    text(after[0]));

  // The fixture says there is no more, so the log must say so and stop asking.
  check('the beginning of the room is marked',
    Array.from(d.querySelectorAll('.chat-rule')).some((r) => text(r) === 'Beginning'));
  check('and the load control is gone', !d.getElementById('chat-load-earlier'));

  const asks = w.__HARNESS_CALLS__.filter((c) => c.cmd === 'matrix_backfill').length;
  d.getElementById('chat-timeline').dispatchEvent(new w.Event('scroll', { bubbles: true }));
  await tick();
  check('scrolling up again does not re-ask',
    w.__HARNESS_CALLS__.filter((c) => c.cmd === 'matrix_backfill').length === asks,
    String(w.__HARNESS_CALLS__.filter((c) => c.cmd === 'matrix_backfill').length));

  // Re-entering a room starts over: its history is available again.
  await w.Chat.openRoom('!raid:matrix.beta.playstructs.com');
  await tick();
  check('a freshly opened room offers history again',
    !!d.getElementById('chat-load-earlier'));
}

// ── Input history ───────────────────────────────────────────────────────────
// Up recalls what you sent — every IRC client and every shell.
{
  console.log('\n— input history');
  const { w, d } = await open();
  await w.Chat.openRoom('!snc:matrix.beta.playstructs.com');
  await tick();
  const inp = () => d.getElementById('chat-input');
  const send = async (t) => {
    inp().value = t;
    d.getElementById('chat-send').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await tick();
  };
  const key = (k) => {
    const n = inp();
    n.setSelectionRange(k === 'ArrowUp' ? 0 : n.value.length, k === 'ArrowUp' ? 0 : n.value.length);
    n.dispatchEvent(new w.KeyboardEvent('keydown', { key: k, bubbles: true }));
  };

  await send('first thing');
  await send('/me waves');
  await send('third thing');

  key('ArrowUp');
  check('Up recalls the newest', inp().value === 'third thing', JSON.stringify(inp().value));
  key('ArrowUp');
  check('again goes further back — commands included',
    inp().value === '/me waves', JSON.stringify(inp().value));
  key('ArrowDown');
  check('Down comes back', inp().value === 'third thing', JSON.stringify(inp().value));
  key('ArrowDown');
  check('and past the newest is a fresh line', inp().value === '', JSON.stringify(inp().value));

  // A draft in progress survives an accidental recall.
  inp().value = 'half written';
  key('ArrowUp');
  check('recall stashes the draft', inp().value === 'third thing', JSON.stringify(inp().value));
  key('ArrowDown');
  check('…and gives it back', inp().value === 'half written', JSON.stringify(inp().value));

  // Consecutive duplicates collapse: sending twice should not need two presses.
  await send('same');
  await send('same');
  key('ArrowUp');
  key('ArrowUp');
  check('a repeated message is stored once',
    inp().value === 'third thing', JSON.stringify(inp().value));
}

// ── Escape ──────────────────────────────────────────────────────────────────
{
  console.log('\n— escape');
  const { w, d } = await open();
  const esc = () => d.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

  await w.Chat.openRoom('!snc:matrix.beta.playstructs.com');
  await tick();
  esc();
  await tick();
  check('Escape leaves a room', w.Chat._state.view === 'channels', w.Chat._state.view);

  w.Chat.go('people');
  await tick();
  esc();
  await tick();
  check('Escape leaves the people picker', w.Chat._state.view === 'channels', w.Chat._state.view);

  w.Chat.go('browse');
  await tick();
  esc();
  await tick();
  check('Escape leaves Browse', w.Chat._state.view === 'channels', w.Chat._state.view);

  // At the top level it does nothing rather than closing the window.
  esc();
  await tick();
  check('at the channel list it does nothing',
    w.Chat._state.view === 'channels'
      && !w.__HARNESS_CALLS__.some((c) => c.cmd === 'close_chat_window'));
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
  const rooms = (counts) => w.__HARNESS_FIXTURES__.matrix_rooms.rooms.map((r) =>
    Object.assign({}, r, counts[r.room_id] || {}));

  w.__HARNESS_EMIT__('matrix::rooms', {
    guild_id: '0-5',
    rooms: rooms({ '!raid:matrix.beta.playstructs.com': { unread: 2 } }),
  });
  await tick();
  const raidOf = () => w.Chat._state.rooms.find(
    (r) => r.room_id === '!raid:matrix.beta.playstructs.com');
  check('a background room carries the server count', raidOf().unread === 2,
    String(raidOf().unread));
  const badge = all(d, '.chat-room-unread').map(text);
  check('unread badge renders', badge.join(',') === '2', badge.join(','));

  // Another network's push must not touch this one's rooms.
  w.__HARNESS_EMIT__('matrix::rooms', {
    guild_id: '0-1',
    rooms: rooms({ '!raid:matrix.beta.playstructs.com': { unread: 99 } }),
  });
  await tick();
  check('another network cannot overwrite this one', raidOf().unread === 2,
    String(raidOf().unread));
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

// ── The first paint ─────────────────────────────────────────────────────────
// "We have not asked yet" is not "there is nothing there". The window used to
// open by announcing a failure it had no evidence for, then correct itself a
// moment later.
{
  console.log('\n— first paint');
  const dom = await JSDOM.fromFile(harness, {
    url: pathToFileURL(harness).href + '?fixture=nomatrix',
    runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true,
    beforeParse(window) {
      // Hold matrix_status open so the very first frame can be inspected —
      // this is exactly the window in which the flash happened.
      window.__HARNESS_HOLD_STATUS__ = true;
    },
  });
  const w = dom.window;
  await until(() => w.Chat && w.Chat._state && text(w.document.body).length > 0);
  const seen = text(w.document.body);
  check('the first paint says it is connecting', seen.includes('Connecting'), seen.slice(0, 120));
  check('…and does NOT claim there is no comms server',
    !seen.includes('No comms server'), seen.slice(0, 160));

  // Let the answer through; only now may it report the truth.
  w.__HARNESS_RELEASE_STATUS__();
  const settled = await until(() => text(w.document.body).includes('No comms server'), 3000);
  check('once asked, it reports what it found', !!settled,
    text(w.document.body).slice(0, 160));
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

// ── Tabs ────────────────────────────────────────────────────────────────────
// The conversations you have open, in the slot the game uses for menu
// sections. A tab is a VIEW, not a membership.
{
  console.log('\n— tabs');
  const { w, d } = await open();
  const tabs = () => all(d, '#menu-page-nav-items .chat-tab');

  check('nothing open shows the network, not a tab',
    tabs().length === 0 && text(d.querySelector('#menu-page-nav-items')) === 'SN.C',
    text(d.querySelector('#menu-page-nav-items')));

  await w.Chat.openRoom('!snc:matrix.beta.playstructs.com');
  await tick();
  check('opening a room opens a tab', tabs().length === 1, String(tabs().length));
  check('…named after the room', text(tabs()[0]).includes('SN.Corporation'), text(tabs()[0]));
  check('…and marked active', tabs()[0].className.includes('sui-mod-active'));

  await w.Chat.openRoom('!raid:matrix.beta.playstructs.com');
  await tick();
  check('a second room opens beside it, not over it', tabs().length === 2, String(tabs().length));
  check('the new one is active', tabs()[1].className.includes('sui-mod-active'));
  check('…and the first is not', !tabs()[0].className.includes('sui-mod-active'));

  // Clicking a tab switches back.
  tabs()[0].dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await tick();
  check('clicking a tab switches to it',
    w.Chat._state.roomId === '!snc:matrix.beta.playstructs.com', String(w.Chat._state.roomId));
  check('and does not open a third', tabs().length === 2, String(tabs().length));

  // The × closes the view. It must NOT leave the room.
  const leaves = w.__HARNESS_CALLS__.filter((c) => c.cmd === 'matrix_leave').length;
  tabs()[1].querySelector('.chat-tab-close')
    .dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await tick();
  check('the × closes the tab', tabs().length === 1, String(tabs().length));
  check('…without leaving the room',
    w.__HARNESS_CALLS__.filter((c) => c.cmd === 'matrix_leave').length === leaves);
  check('…and without switching to it',
    w.Chat._state.roomId === '!snc:matrix.beta.playstructs.com', String(w.Chat._state.roomId));

  // Closing the tab you are LOOKING at hands you the neighbour.
  await w.Chat.openRoom('!ninja:matrix.beta.playstructs.com');
  await tick();
  check('two open again', tabs().length === 2, String(tabs().length));
  tabs()[1].querySelector('.chat-tab-close')
    .dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await tick();
  check('closing the active tab falls back to its neighbour',
    w.Chat._state.roomId === '!snc:matrix.beta.playstructs.com', String(w.Chat._state.roomId));

  // Closing the last one has nowhere to fall back to.
  tabs()[0].querySelector('.chat-tab-close')
    .dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await tick();
  check('closing the last tab returns to the channel list',
    w.Chat._state.view === 'channels', w.Chat._state.view);
  check('and the strip names the network again',
    text(d.querySelector('#menu-page-nav-items')) === 'SN.C',
    text(d.querySelector('#menu-page-nav-items')));
}

{
  console.log('\n— tab unread + bounds');
  const { w, d } = await open();
  await w.Chat.openRoom('!snc:matrix.beta.playstructs.com');
  await tick();
  await w.Chat.openRoom('!raid:matrix.beta.playstructs.com');
  await tick();

  // Traffic in a tab you are not looking at marks it.
  w.__HARNESS_EMIT__('matrix::rooms', {
    guild_id: '0-5',
    rooms: w.__HARNESS_FIXTURES__.matrix_rooms.rooms.map((r) =>
      Object.assign({}, r,
        r.room_id === '!snc:matrix.beta.playstructs.com' ? { unread: 1 } : {})),
  });
  await tick();
  const tabs = () => all(d, '#menu-page-nav-items .chat-tab');
  check('an unread tab gets a dot',
    tabs()[0].querySelector('.chat-tab-dot') !== null);
  check('…and a plain one does not',
    tabs()[1].querySelector('.chat-tab-dot') === null);

  w.__HARNESS_EMIT__('matrix::rooms', {
    guild_id: '0-5',
    rooms: w.__HARNESS_FIXTURES__.matrix_rooms.rooms.map((r) =>
      Object.assign({}, r,
        r.room_id === '!snc:matrix.beta.playstructs.com'
          ? { unread: 2, mention: true } : {})),
  });
  await tick();
  check('being named colours the dot',
    tabs()[0].querySelector('.chat-tab-dot').className.includes('chat-mod-mention'));

  // The strip is bounded: a long session must not become a scrollbar.
  for (let i = 0; i < 12; i++) w.Chat.openTab('!filler' + i + ':h');
  check('the strip is capped', w.Chat._state.tabs.length <= 8,
    String(w.Chat._state.tabs.length));
  check('…and keeps the room you are in',
    w.Chat._state.tabs.indexOf('!raid:matrix.beta.playstructs.com') !== -1
      || w.Chat._state.roomId !== '!raid:matrix.beta.playstructs.com');
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

// ── Shared from the game ────────────────────────────────────────────────────
// A raid window or a roster row can hand an object to Comms. It must arrive as
// a DRAFT: sharing is one click from a game window, and one click must never
// put a message in front of other people.
{
  console.log('\n— share from the game');
  const { w, d } = await open();

  // Arriving while a room is open: straight into the message box, unsent.
  await w.Chat.openRoom('!snc:matrix.beta.playstructs.com');
  await tick();
  const before = w.__HARNESS_CALLS__.filter((c) => c.cmd === 'matrix_send').length;
  w.__HARNESS_EMIT__('matrix::compose', { text: '2-15361' });
  await tick();
  const input = d.getElementById('chat-input');
  check('a shared id lands in the message box', input.value.trim() === '2-15361',
    JSON.stringify(input.value));
  check('…and nothing is sent without the player',
    w.__HARNESS_CALLS__.filter((c) => c.cmd === 'matrix_send').length === before);
  check('…with the caret after it, ready to type',
    input.selectionStart === input.value.length,
    input.selectionStart + '/' + input.value.length);

  // A draft already being written is the player's. Sharing appends.
  input.value = 'look at';
  input.dispatchEvent(new w.Event('input', { bubbles: true }));
  w.__HARNESS_EMIT__('matrix::compose', { text: '1-61' });
  await tick();
  check('sharing into a half-written line keeps what was typed',
    d.getElementById('chat-input').value.trim() === 'look at 1-61',
    JSON.stringify(d.getElementById('chat-input').value));

  // Arriving with no room open: hold it, say so, and deliver on the next open.
  w.Chat.go('channels');
  await tick();
  w.__HARNESS_EMIT__('matrix::compose', { text: '2-15361' });
  await tick();
  check('with no room open it waits on the channel list',
    text(d.querySelector('.chat-scroll')).includes('Ready to share 2-15361'),
    text(d.querySelector('.chat-scroll')).slice(0, 80));
  await w.Chat.openRoom('!snc:matrix.beta.playstructs.com');
  await tick();
  check('…and is waiting in the box once a room is picked',
    d.getElementById('chat-input').value.trim() === '2-15361',
    JSON.stringify(d.getElementById('chat-input').value));
  check('…and is not offered a second time', !w.Chat._state.draft,
    String(w.Chat._state.draft));

  // The shared id must actually render as a card once sent — a share that
  // arrives as bare text would be no better than retyping it.
  check('a shared id is a referenceable kind',
    w.Chat.refIdsIn('2-15361').indexOf('2-15361') >= 0,
    JSON.stringify(w.Chat.refIdsIn('2-15361')));
}

// A share that reached Rust before the window was listening is replayed.
{
  console.log('\n— share replayed into a cold window');
  const dom = await JSDOM.fromFile(harness, {
    url: pathToFileURL(harness).href,
    runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true,
    beforeParse(window) { window.__HARNESS_PENDING_DRAFT__ = '2-15361'; },
  });
  const w = dom.window;
  await until(() => w.Chat && w.Chat._state && !w.Chat._state.loading);
  await tick();
  check('the window claims the share it was opened for',
    w.__HARNESS_CALLS__.some((c) => c.cmd === 'matrix_take_pending_draft'));
  check('…and holds it until a room is chosen',
    w.Chat._state.draft === '2-15361', String(w.Chat._state.draft));
}

// ── The face other clients see ──────────────────────────────────────────────
// The portrait always renders in here, composed from on-chain layer indices.
// Every OTHER Matrix client reads a single avatar_url and nothing else, so a
// player with no published avatar is a grey initial in Element and has no way
// to find that out from inside this window.
{
  console.log('\n— portrait publication');
  const { w, d } = await open();
  await w.Chat.openRoom('!snc:matrix.beta.playstructs.com');
  await tick();
  const p = d.getElementById('chat-composer-portrait');
  check('the composer shows your own portrait, not a placeholder',
    p && !!p.querySelector('img[src*="pfp_head_1.png"]'),
    p && p.innerHTML.slice(0, 120));
  check('…and says the face is one other clients can see',
    (p.getAttribute('data-sui-tooltip') || '').includes('published'),
    p.getAttribute('data-sui-tooltip'));
}

{
  const dom = await JSDOM.fromFile(harness, {
    url: pathToFileURL(harness).href,
    runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true,
    beforeParse(window) { window.__HARNESS_AVATAR_UNPUBLISHED__ = true; },
  });
  const w = dom.window;
  await until(() => w.Chat && w.Chat._state && !w.Chat._state.loading);
  await w.Chat.openRoom('!snc:matrix.beta.playstructs.com');
  await tick();
  const tip = w.document.getElementById('chat-composer-portrait')
    .getAttribute('data-sui-tooltip');
  check('an unpublished portrait says so without alarming anyone',
    tip.includes('not published') && tip.includes('shortly'), tip);
}

// ── The action bar's geometry ───────────────────────────────────────────────
// jsdom does no layout, so this cannot measure alignment. What it CAN do is
// hold onto the three rules that were arrived at by measuring a real render —
// each one fixes something that looked wrong on screen and looks fine in the
// markup, which is exactly the kind of rule that gets tidied away later.
{
  console.log('\n— composer action bar');
  const { w, d } = await open();
  await w.Chat.openRoom('!snc:matrix.beta.playstructs.com');
  await tick();

  const rules = Array.from(d.styleSheets)
    .flatMap((s) => { try { return Array.from(s.cssRules); } catch (e) { return []; } })
    .filter((r) => r.selectorText);
  const ruleFor = (sel) => rules.find((r) => r.selectorText === sel);

  // A `.sui-panel-chunk` is a COLUMN flex container, so the vertical axis is
  // `justify-content`. Setting `align-items` here changed nothing at all.
  const chunk = ruleFor('#chat-composer .sui-panel-chunk');
  check('the bar centres its controls on the vertical axis',
    chunk && chunk.style.getPropertyValue('justify-content') === 'center',
    chunk && chunk.style.cssText);

  // The portrait well defaults to 40px against a 48px send button; matching
  // them is what makes the two ends of the bar read as one row.
  const well = rules.find((r) =>
    r.selectorText.includes('#chat-composer .sui-screen-portrait') &&
    r.style.height);
  check('the portrait matches the send button at 48px',
    well && well.style.height === '48px', well && well.style.cssText);

  // SUI hides the portrait on hover to reveal an action icon. Here the
  // portrait is the player's own face carrying the publication tooltip, so it
  // vanished at the moment someone hovered to read it.
  const hover = ruleFor('#chat-composer .sui-screen-portrait:hover .sui-screen-portrait-image');
  check('the portrait does not vanish when hovered for its tooltip',
    hover && hover.style.display === 'block', hover && hover.style.cssText);

  // The bar's three controls: one portrait, one field, one send.
  const bar = d.getElementById('chat-composer');
  check('the bar is the portrait, the field and send — nothing else',
    bar.querySelectorAll('.sui-panel-chunk').length === 3,
    String(bar.querySelectorAll('.sui-panel-chunk').length));
}

// ── Finding something that was said ─────────────────────────────────────────
// The window keeps a few hundred messages of one room. What is worth finding —
// who agreed to what, which planet somebody flagged a week ago — is almost
// never in that window, so the homeserver does the searching.
{
  console.log('\n— search');
  const { w, d } = await open();
  w.__HARNESS_HITS__ = [
    { room_id: '!snc:matrix.beta.playstructs.com', room_name: 'SN.Corporation',
      message: { event_id: '$s1', sender: '@1-61:h', sender_name: 'JPEG',
        body: 'the refinery on 2-15361 is ours', kind: 'text', ts: 1787000000000 } },
    { room_id: '!raid:matrix.beta.playstructs.com', room_name: 'Raid',
      message: { event_id: '$s2', sender: '@1-42:h', sender_name: 'Netlag',
        body: 'hitting 2-15361 at dawn', kind: 'text', ts: 1787000100000 } },
  ];

  await w.Chat.openRoom('!snc:matrix.beta.playstructs.com');
  await tick();

  // Ctrl-F is how most people will ever find this. Scoped to what they are
  // reading, because that is where they are standing.
  d.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true }));
  await tick();
  check('ctrl-F opens search', w.Chat._state.view === 'search', w.Chat._state.view);
  check('…scoped to the conversation being read',
    w.Chat._state.searchRoom === '!snc:matrix.beta.playstructs.com',
    String(w.Chat._state.searchRoom));
  check('…with the field focused', d.activeElement.id === 'chat-search-query',
    d.activeElement.id);
  check('…and nothing searched yet',
    w.__HARNESS_CALLS__.filter((c) => c.cmd === 'matrix_search').length === 0);

  // On Enter, not per keystroke: a search is a round trip over the whole
  // history of every room, and typing "raid" would fire four of them.
  const field = d.getElementById('chat-search-query');
  field.value = 'refin';
  field.dispatchEvent(new w.Event('input', { bubbles: true }));
  await tick();
  check('typing alone does not search',
    w.__HARNESS_CALLS__.filter((c) => c.cmd === 'matrix_search').length === 0);

  field.value = '2-15361';
  field.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await tick();
  const call = w.__HARNESS_CALLS__.filter((c) => c.cmd === 'matrix_search').pop();
  check('Enter searches', !!call && call.args.query === '2-15361',
    JSON.stringify(call && call.args));
  check('…inside the room, when scoped there',
    call.args.roomId === '!snc:matrix.beta.playstructs.com', String(call.args.roomId));
  const hits = all(d, '.chat-search-hit');
  check('a scoped search shows only that room', hits.length === 1, String(hits.length));
  check('…and names the room it was in',
    text(hits[0].querySelector('.chat-search-hit-room')) === 'SN.Corporation',
    text(hits[0].querySelector('.chat-search-hit-room')));
  check('…and shows the message itself',
    text(hits[0]).includes('the refinery on 2-15361 is ours'), text(hits[0]));

  // Widening is one control, and it re-runs rather than making you retype.
  const before = w.__HARNESS_CALLS__.filter((c) => c.cmd === 'matrix_search').length;
  d.querySelector('.chat-page .chat-header-actions a')
    .dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await tick();
  check('widening the scope re-runs the search',
    w.__HARNESS_CALLS__.filter((c) => c.cmd === 'matrix_search').length === before + 1);
  check('…without the room filter',
    !w.__HARNESS_CALLS__.filter((c) => c.cmd === 'matrix_search').pop().args.roomId);
  check('…and finds it everywhere', all(d, '.chat-search-hit').length === 2,
    String(all(d, '.chat-search-hit').length));

  // A hit is worth clicking because it says where it was.
  all(d, '.chat-search-hit-room')[1].dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await tick();
  check('clicking a hit opens that conversation',
    w.Chat._state.roomId === '!raid:matrix.beta.playstructs.com',
    String(w.Chat._state.roomId));
}

// A slow answer to an old question must not paint over a newer one.
{
  console.log('\n— stale search answers');
  const { w, d } = await open();
  w.__HARNESS_HITS__ = [
    { room_id: '!snc:matrix.beta.playstructs.com', room_name: 'SN.Corporation',
      message: { event_id: '$old', sender: '@1-61:h', sender_name: 'JPEG',
        body: 'the slow answer', kind: 'text', ts: 1 } },
  ];
  w.Chat.openSearch(false);
  await tick();
  w.__HARNESS_HOLD_SEARCH__ = true;
  w.Chat.runSearch('first');
  await tick();
  w.__HARNESS_HITS__ = [
    { room_id: '!raid:matrix.beta.playstructs.com', room_name: 'Raid',
      message: { event_id: '$new', sender: '@1-42:h', sender_name: 'Netlag',
        body: 'the current answer', kind: 'text', ts: 2 } },
  ];
  await w.Chat.runSearch('second');
  await tick();
  w.__HARNESS_RELEASE_SEARCH__();
  await tick();
  check('the stale answer is discarded',
    text(d.querySelector('.chat-scroll')).includes('the current answer') &&
    !text(d.querySelector('.chat-scroll')).includes('the slow answer'),
    text(d.querySelector('.chat-scroll')).slice(0, 120));
}

// ── The room's shortlist ────────────────────────────────────────────────────
// Search finds what you remember. A room also needs a place for the handful of
// things everyone in it needs — the current target, the standing rules.
{
  console.log('\n— pinned messages');
  const { w, d } = await open();
  w.__HARNESS_PINS__ = [
    { event_id: '$p1', sender: '@1-61:h', sender_name: 'JPEG',
      body: 'target for tonight is 2-15361', kind: 'text', ts: 1787000000000 },
  ];
  w.__HARNESS_PINNED_IDS__ = ['$p1'];

  // Arriving in a room with pins: one line, not a second timeline.
  w.__HARNESS_EMIT__('matrix::rooms', {
    guild_id: '0-5',
    rooms: w.__HARNESS_FIXTURES__.matrix_rooms.rooms.map((r) =>
      Object.assign({}, r,
        r.room_id === '!snc:matrix.beta.playstructs.com' ? { pinned: ['$p1'] } : {})),
  });
  await tick();
  await w.Chat.openRoom('!snc:matrix.beta.playstructs.com');
  await tick();

  const strip = d.querySelector('.chat-pins');
  check('a room with pins says so', !!strip);
  check('…as one collapsed line', text(strip).includes('Pinned message') &&
    !d.querySelector('.chat-pins-body'), text(strip));
  check('…and has not fetched them yet',
    w.__HARNESS_CALLS__.filter((c) => c.cmd === 'matrix_pinned').length === 0);

  d.querySelector('.chat-pins-head').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await tick();
  check('opening it fetches them',
    w.__HARNESS_CALLS__.filter((c) => c.cmd === 'matrix_pinned').length === 1);
  check('…and shows the message',
    text(d.querySelector('.chat-pins-body')).includes('target for tonight is 2-15361'),
    text(d.querySelector('.chat-pins-body')));

  // Pinning is a per-message action in the timeline.
  const msgs = all(d, '#chat-timeline .chat-msg');
  const target = msgs.find((n) => text(n).includes('you around?'));
  const btn = target.querySelector('.chat-pin-btn');
  check('a message offers a pin', !!btn, target.innerHTML.slice(0, 100));
  btn.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await tick();
  const call = w.__HARNESS_CALLS__.filter((c) => c.cmd === 'matrix_pin').pop();
  check('clicking it pins that event', !!call && call.args.pin === true,
    JSON.stringify(call && call.args));
  check('…and the room now holds both',
    w.Chat._state.room.pinned.length === 2,
    JSON.stringify(w.Chat._state.room.pinned));

  // Unpinning from the strip, where the pins actually are.
  const unpin = d.querySelector('.chat-pin .chat-pin-btn');
  unpin.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await tick();
  const off = w.__HARNESS_CALLS__.filter((c) => c.cmd === 'matrix_pin').pop();
  check('the strip can unpin', off.args.pin === false, JSON.stringify(off.args));

  // A local echo has no server event id, so it cannot be pinned at all.
  check('a pending message offers no pin',
    w.Chat.setPin(undefined, true) === undefined &&
    w.Chat.setPin('local-1', true) === undefined);
}

// A room with no pins says nothing at all.
{
  console.log('\n— no pins');
  const { w, d } = await open();
  await w.Chat.openRoom('!snc:matrix.beta.playstructs.com');
  await tick();
  check('an unpinned room shows no strip', d.querySelector('.chat-pins') === null);
  check('…and does not ask for pins it has not got',
    w.__HARNESS_CALLS__.filter((c) => c.cmd === 'matrix_pinned').length === 0);
}

// ── Replies ────────────────────────────────────────────────────────────────
// In a busy guild room, "yes, do it" three messages after the question is
// genuinely ambiguous. A reply says which question.
{
  console.log('\n— replies');
  const { w, d } = await open();
  await w.Chat.openRoom('!snc:matrix.beta.playstructs.com');
  await tick();

  const msgs = all(d, '#chat-timeline .chat-msg');
  const question = msgs.find((n) => text(n).includes('you around?'));
  check('a message offers a reply', !!question.querySelector('.chat-reply-btn'));

  question.querySelector('.chat-reply-btn')
    .dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await tick();
  check('replying names what is being answered', !!d.getElementById('chat-reply-chip'));
  check('…by sender and text',
    text(d.getElementById('chat-reply-chip')).includes('T.Xue') &&
    text(d.getElementById('chat-reply-chip')).includes('you around?'),
    text(d.getElementById('chat-reply-chip')));
  check('…and the composer is focused', d.activeElement.id === 'chat-input',
    d.activeElement.id);

  // Escape drops the reply before it means "leave the room".
  const input = d.getElementById('chat-input');
  input.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await tick();
  check('escape cancels the reply', !w.Chat._state.replyTo);
  check('…without leaving the room',
    w.Chat._state.roomId === '!snc:matrix.beta.playstructs.com',
    String(w.Chat._state.roomId));

  // Re-arm and send.
  question.querySelector('.chat-reply-btn')
    .dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await tick();
  d.getElementById('chat-input').value = 'agreed';
  d.getElementById('chat-input')
    .dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await tick();
  const sent = w.__HARNESS_CALLS__.filter((c) => c.cmd === 'matrix_send').pop();
  check('the reply carries what it answers',
    !!sent.args.replyTo && sent.args.replyTo.eventId === '$14',
    JSON.stringify(sent.args.replyTo));
  check('…with the sender and body Rust needs for the fallback',
    sent.args.replyTo.sender === '@1-77:matrix.beta.playstructs.com' &&
    sent.args.replyTo.body === 'you around?',
    JSON.stringify(sent.args.replyTo));
  check('…and the target is cleared once sent', !w.Chat._state.replyTo);
  check('…and the chip is gone', !d.getElementById('chat-reply-chip'));

  // The echo shows the quote at once, not when sync catches up.
  const echo = all(d, '#chat-timeline .chat-msg').pop();
  check('your own reply renders as a reply',
    !!echo.querySelector('.chat-reply-quote'), echo.innerHTML.slice(0, 120));
  check('…naming who it answers',
    text(echo.querySelector('.chat-reply-who')) === 'T.Xue',
    text(echo.querySelector('.chat-reply-who')));
}

// An incoming reply renders its quote, and the quote is a way back.
{
  console.log('\n— incoming replies');
  const { w, d } = await open();
  await w.Chat.openRoom('!snc:matrix.beta.playstructs.com');
  await tick();
  w.__HARNESS_EMIT__('matrix::timeline', {
    guild_id: '0-5', room_id: '!snc:matrix.beta.playstructs.com',
    messages: [{
      event_id: '$reply1', sender: '@1-61:h', sender_name: 'JPEG',
      body: 'on my way', kind: 'text', ts: 1787900099000,
      reply_to: '$14', reply_sender: '@1-77:matrix.beta.playstructs.com',
      reply_excerpt: 'you around?',
    }],
  });
  await tick();
  const reply = all(d, '#chat-timeline .chat-msg').pop();
  const quote = reply.querySelector('.chat-reply-quote');
  check('an incoming reply shows what it answers', !!quote);
  check('…by the name a player knows, not a matrix id',
    text(quote.querySelector('.chat-reply-who')) === 'T.Xue',
    text(quote.querySelector('.chat-reply-who')));
  check('…and the quote is not the whole message twice',
    !text(reply).includes('> '), text(reply));

  // Clicking the quote goes to the message it answers.
  const answered = d.querySelector('[data-event="$14"]');
  check('the answered message is addressable', !!answered);
  quote.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await tick();
  check('clicking the quote marks what it answers',
    answered.className.includes('chat-mod-found'), answered.className);

  // A quote pointing at scrollback this window does not hold says so rather
  // than jumping somewhere wrong.
  w.__HARNESS_EMIT__('matrix::timeline', {
    guild_id: '0-5', room_id: '!snc:matrix.beta.playstructs.com',
    messages: [{
      event_id: '$reply2', sender: '@1-61:h', sender_name: 'JPEG',
      body: 'as we said', kind: 'text', ts: 1787900100000,
      reply_to: '$ancient', reply_sender: '@1-42:h', reply_excerpt: 'long ago',
    }],
  });
  await tick();
  all(d, '.chat-reply-quote').pop()
    .dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await tick();
  check('a quote pointing past the window says so',
    text(d.querySelector('#chat-timeline')).includes('further back than this window holds'),
    text(d.querySelector('#chat-timeline')).slice(-120));
}

// ── Reactions ──────────────────────────────────────────────────────────────
// A raid plan gets six "ack" messages that push the plan off the screen. One
// glyph answers the same question and costs a line nobody has to read.
{
  console.log('\n— reactions');
  const { w, d } = await open();
  await w.Chat.openRoom('!snc:matrix.beta.playstructs.com');
  await tick();

  // Arriving from someone else, on a message already on screen.
  w.__HARNESS_EMIT__('matrix::reactions', {
    guild_id: '0-5', room_id: '!snc:matrix.beta.playstructs.com', event_id: '$14',
    reactions: [{ key: 'ACK', count: 2, mine: false, who: ['JPEG', 'Netlag'] }],
  });
  await tick();
  const msg = d.querySelector('[data-event="$14"]');
  const chip = msg.querySelector('.chat-reaction');
  check('a reaction shows on its message', !!chip, msg.innerHTML.slice(0, 140));
  check('…with its count', text(chip) === 'ACK2', text(chip));
  check('…and names who agreed, which a count cannot',
    chip.title === 'JPEG, Netlag', chip.title);
  check('…and is not marked as mine',
    !chip.className.includes('sui-mod-warning'), chip.className);

  // Clicking joins it.
  chip.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await tick();
  const call = w.__HARNESS_CALLS__.filter((c) => c.cmd === 'matrix_react').pop();
  check('clicking a reaction joins it',
    call.args.on === true && call.args.key === 'ACK' && call.args.eventId === '$14',
    JSON.stringify(call.args));

  // A reaction for another room must not paint this one.
  const wasCount = all(d, '[data-event="$14"] .chat-reaction').length;
  w.__HARNESS_EMIT__('matrix::reactions', {
    guild_id: '0-5', room_id: '!raid:matrix.beta.playstructs.com', event_id: '$14',
    reactions: [{ key: 'NO', count: 9, mine: false, who: [] }],
  });
  await tick();
  check('another room cannot repaint this one',
    all(d, '[data-event="$14"] .chat-reaction').length === wasCount,
    String(all(d, '[data-event="$14"] .chat-reaction').length));

  // The picker offers a short set, one message at a time.
  const other = d.querySelector('[data-event="$13"]') || all(d, '.chat-msg')[0];
  const add = other.querySelector('.chat-react-btn');
  check('a message offers a reaction control', !!add);
  add.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await tick();
  // Eight intents plus the control that reveals the struct art.
  check('the picker opens on that message',
    all(d, '.chat-reaction.chat-mod-offer').length === 9,
    String(all(d, '.chat-reaction.chat-mod-offer').length));
  check('…and only on that one', w.Chat._state.reactPicker === other.getAttribute('data-event'),
    String(w.Chat._state.reactPicker));

  // The offers are the game's own icons, not text.
  const first = d.querySelector('.chat-reaction.chat-mod-offer');
  check('an offer renders as a game icon',
    !!first.querySelector('i.icon-okay'), first.innerHTML);

  // Twenty hulls open by default would be a wall across the message.
  d.querySelector('.chat-reaction.chat-mod-more')
    .dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await tick();
  const hulls = all(d, '.chat-reaction-struct');
  check('the struct sheet opens on request', hulls.length === 20, String(hulls.length));
  check('…as real struct art from the bundle',
    hulls[0].getAttribute('src') === 'img/structs/cmd-ship/cmd-ship-struct-base.png',
    hulls[0].getAttribute('src'));

  // Picking one sends the shortcode, which is what stays readable elsewhere.
  hulls[1].parentElement.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await tick();
  const struck = w.__HARNESS_CALLS__.filter((c) => c.cmd === 'matrix_react').pop();
  check('a struct reaction sends its shortcode',
    struck.args.key === ':struct/destroyer:', JSON.stringify(struck.args));
  check('…and closing the picker forgets the sheet', !w.Chat._state.reactStructs);
}

// The glyph vocabulary, which is what makes a key game-native or not.
{
  console.log('\n— reaction glyphs');
  const { w } = await open();
  const g = w.Chat.reactionGlyph;

  check('a known shortcode becomes a SUI icon',
    g(':raid:').tagName === 'I' && g(':raid:').className.includes('icon-raid'),
    g(':raid:').outerHTML);
  check('a struct shortcode becomes its picture',
    g(':struct/tank:').tagName === 'IMG' &&
    g(':struct/tank:').src.includes('tank-struct-base.png'),
    g(':struct/tank:').outerHTML);

  // Anything else is somebody else's content and must still show as itself —
  // an emoji from Element, a word from a bot, a shortcode we do not know.
  check('an emoji from another client still renders',
    g('\uD83D\uDC4D').tagName === 'SPAN' && g('\uD83D\uDC4D').textContent === '\uD83D\uDC4D',
    g('\uD83D\uDC4D').outerHTML);
  check('a plain word still renders',
    g('ack').textContent === 'ack', g('ack').outerHTML);
  check('an unknown shortcode is shown, not swallowed',
    g(':nosuchicon:').textContent === ':nosuchicon:', g(':nosuchicon:').outerHTML);
  // A key naming a struct that does not ship must not become a broken image.
  check('an unknown hull is not a broken image',
    g(':struct/nothing:').tagName === 'SPAN', g(':struct/nothing:').outerHTML);
}

// The optimistic update, which is what the click actually feels like.
{
  console.log('\n— reaction arithmetic');
  const { w } = await open();
  const o = w.Chat.optimistic;

  check('a new key starts at one and is mine',
    JSON.stringify(o([], 'ACK', true)) ===
      JSON.stringify([{ key: 'ACK', count: 1, mine: true, who: [] }]));

  const two = [{ key: 'ACK', count: 2, mine: false, who: ['a', 'b'] }];
  check('joining raises the count', o(two, 'ACK', true)[0].count === 3);
  check('…and marks it mine', o(two, 'ACK', true)[0].mine === true);

  const mine = [{ key: 'ACK', count: 2, mine: true, who: ['a', 'You'] }];
  check('leaving lowers it', o(mine, 'ACK', false)[0].count === 1);
  check('…and unmarks it', o(mine, 'ACK', false)[0].mine === false);

  // A key nobody holds any more is gone, not a chip reading zero.
  const one = [{ key: 'ACK', count: 1, mine: true, who: ['You'] }];
  check('the last one leaving removes the key', o(one, 'ACK', false).length === 0,
    JSON.stringify(o(one, 'ACK', false)));

  // Most-agreed first, and stable when level so the row does not shuffle.
  const many = [
    { key: 'B', count: 1, mine: false, who: [] },
    { key: 'A', count: 1, mine: false, who: [] },
    { key: 'C', count: 5, mine: false, who: [] },
  ];
  check('ordered by agreement, then by key',
    o(many, 'Z', false).map((r) => r.key).join('') === 'CAB',
    o(many, 'Z', false).map((r) => r.key).join(''));
}

// ── Completing an id ───────────────────────────────────────────────────────
// Players talk in ids, and typing one from memory is how you end up naming
// somebody else's planet. Tab completes them like it completes names.
{
  console.log('\n— id completion');
  const { w, d } = await open();
  await w.Chat.openRoom('!snc:matrix.beta.playstructs.com');
  await tick();

  // What the ROOM has said comes first: "what was that planet again" is a
  // question the conversation itself answers.
  const hits = w.Chat.idCompletions('2-');
  check('ids said in this room are completable', hits.indexOf('2-15361') !== -1,
    JSON.stringify(hits));

  // Your own objects are there too, so they are never mistyped.
  check('your own planet is completable',
    w.Chat.idCompletions('2-9').indexOf('2-9001') !== -1,
    JSON.stringify(w.Chat.idCompletions('2-9')));
  check('…and your own fleet', w.Chat.idCompletions('9-').indexOf('9-77') !== -1,
    JSON.stringify(w.Chat.idCompletions('9-')));

  // A stem matching nothing offers nothing rather than everything.
  check('an unmatched stem completes to nothing',
    w.Chat.idCompletions('7-999').length === 0,
    JSON.stringify(w.Chat.idCompletions('7-999')));

  // Tab in the composer completes it, and — the part that matters — does NOT
  // prefix it with @. That would turn a reference into a mention of nobody.
  const input = d.getElementById('chat-input');
  input.value = 'hitting 2-1';
  input.dispatchEvent(new w.Event('input', { bubbles: true }));
  input.selectionStart = input.value.length;
  input.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
  await tick();
  check('Tab completes an id in the composer',
    input.value.indexOf('2-15361') !== -1, JSON.stringify(input.value));
  check('…without turning it into a mention',
    input.value.indexOf('@2-') === -1, JSON.stringify(input.value));

  // The hint answers "which one is that", which is the question cycling asks.
  const hint = d.getElementById('chat-complete-hint');
  check('the hint names the object being offered',
    text(hint).includes('2-15361'), text(hint));

  // Typing again clears it — a stale hint describes the wrong thing.
  input.dispatchEvent(new w.Event('input', { bubbles: true }));
  await tick();
  check('typing clears the hint', text(hint) === '', text(hint));

  // Names still complete as mentions; the id path must not have eaten them.
  input.value = 'Netl';
  input.selectionStart = input.value.length;
  input.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
  await tick();
  check('a name still completes as a mention',
    input.value.indexOf('@Netlag') === 0, JSON.stringify(input.value));
}

// ── Taking a message back ──────────────────────────────────────────────────
// You can always re-send a corrected message. You cannot unsay one.
{
  console.log('\n— unsend');
  const { w, d } = await open();
  await w.Chat.openRoom('!snc:matrix.beta.playstructs.com');
  await tick();

  // Offered on your own messages only. A moderator could redact anyone's, but
  // offering that to everybody is an invitation to click and be refused.
  const mine = all(d, '.chat-msg').find((n) => n.className.includes('chat-mod-self')) ||
    all(d, '#chat-timeline .chat-msg').find((n) => n.querySelector('.chat-delete-btn'));
  const theirs = all(d, '#chat-timeline .chat-msg')
    .find((n) => text(n).includes('you around?'));
  check('somebody else\'s message offers no delete',
    !theirs.querySelector('.chat-delete-btn'));

  // Send one, so there is something of ours to take back.
  const input = d.getElementById('chat-input');
  input.value = 'wrong id, sorry';
  input.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await tick();
  await tick();
  const own = all(d, '#chat-timeline .chat-msg').pop();
  const del = own.querySelector('.chat-delete-btn');
  check('your own message offers a delete', !!del, own.innerHTML.slice(0, 160));

  // One click arms, it does not delete. The control sits in a row of harmless
  // neighbours and this cannot be undone.
  del.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await tick();
  check('the first click only arms it',
    w.__HARNESS_CALLS__.filter((c) => c.cmd === 'matrix_redact').length === 0);
  check('…and says so', w.Chat._state.deleteArmed !== null,
    String(w.Chat._state.deleteArmed));

  // Moving away cancels: an armed control left behind is a trap.
  all(d, '#chat-timeline .chat-msg').pop().querySelector('.chat-delete-btn')
    .dispatchEvent(new w.MouseEvent('mouseleave', { bubbles: true }));
  await tick();
  check('moving away disarms it', w.Chat._state.deleteArmed === null);

  // Arm and confirm.
  const again = () => all(d, '#chat-timeline .chat-msg').pop().querySelector('.chat-delete-btn');
  again().dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await tick();
  again().dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await tick();
  const call = w.__HARNESS_CALLS__.filter((c) => c.cmd === 'matrix_redact').pop();
  check('the second click removes it', !!call, JSON.stringify(call && call.args));
  check('…and it reads as removed at once',
    text(all(d, '#chat-timeline .chat-msg').pop()).includes('message removed'),
    text(all(d, '#chat-timeline .chat-msg').pop()));
}

// Somebody else taking one back has to land here too.
{
  console.log('\n— redaction from elsewhere');
  const { w, d } = await open();
  await w.Chat.openRoom('!snc:matrix.beta.playstructs.com');
  await tick();
  const before = d.querySelector('[data-event="$14"]');
  check('the message is there to begin with',
    text(before).includes('you around?'), text(before));

  w.__HARNESS_EMIT__('matrix::redacted', {
    guild_id: '0-5', room_id: '!snc:matrix.beta.playstructs.com', event_id: '$14',
  });
  await tick();
  const after = d.querySelector('[data-event="$14"]');
  // Rewritten, not dropped: a message that silently vanishes reads as a bug,
  // and the gap is what everyone else still sees.
  check('it is rewritten in place', !!after && text(after).includes('message removed'),
    after && text(after));
  check('…and its text is gone', !text(after).includes('you around?'), text(after));

  // A redaction for another room must not touch this one.
  const other = all(d, '#chat-timeline .chat-msg').length;
  w.__HARNESS_EMIT__('matrix::redacted', {
    guild_id: '0-5', room_id: '!raid:matrix.beta.playstructs.com', event_id: '$13',
  });
  await tick();
  check('another room is left alone',
    all(d, '#chat-timeline .chat-msg').length === other &&
    !text(d.querySelector('[data-event="$13"]') || d.body).includes('message removed'),
    String(all(d, '#chat-timeline .chat-msg').length));
}

// ── Changing what you already said ─────────────────────────────────────────
// The other half of "I got that wrong", and the half that does not require
// deleting and re-typing the whole line.
{
  console.log('\n— editing');
  const { w, d } = await open();
  await w.Chat.openRoom('!snc:matrix.beta.playstructs.com');
  await tick();

  const input = d.getElementById('chat-input');
  input.value = 'raid 2-15631';
  input.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await tick(); await tick();

  const own = () => all(d, '#chat-timeline .chat-msg').pop();
  check("somebody else's message offers no edit",
    !all(d, '#chat-timeline .chat-msg')
      .find((n) => text(n).includes('you around?')).querySelector('.chat-edit-btn'));

  own().querySelector('.chat-edit-btn').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await tick();
  check('editing says so above the bar', !!d.getElementById('chat-edit-chip'));
  // The message goes back into the composer — the only place in this window
  // that knows how to write one.
  check('…and puts the text back in the composer',
    d.getElementById('chat-input').value === 'raid 2-15631',
    JSON.stringify(d.getElementById('chat-input').value));

  // Escape keeps it as it was.
  d.getElementById('chat-input')
    .dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await tick();
  check('escape abandons the edit', !w.Chat._state.editing);
  check('…and does not leave the room',
    w.Chat._state.roomId === '!snc:matrix.beta.playstructs.com');

  // Re-arm and commit.
  own().querySelector('.chat-edit-btn').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await tick();
  const field = d.getElementById('chat-input');
  field.value = 'raid 2-15361';
  field.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await tick();
  const call = w.__HARNESS_CALLS__.filter((c) => c.cmd === 'matrix_edit').pop();
  check('Enter rewrites rather than sends',
    !!call && call.args.body === 'raid 2-15361', JSON.stringify(call && call.args));
  check('…and no second message was sent',
    w.__HARNESS_CALLS__.filter((c) => c.cmd === 'matrix_send').length === 1,
    String(w.__HARNESS_CALLS__.filter((c) => c.cmd === 'matrix_send').length));
  check('…the message now reads the new way',
    text(own()).includes('raid 2-15361') && !text(own()).includes('2-15631'),
    text(own()));
  check('…and says it was changed', !!own().querySelector('.chat-msg-edited'),
    own().innerHTML.slice(-160));

  // A slash command typed while editing must not run instead of correcting —
  // that is a surprising way to lose a correction.
  own().querySelector('.chat-edit-btn').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await tick();
  const before = w.__HARNESS_CALLS__.length;
  const f2 = d.getElementById('chat-input');
  f2.value = '/me waves';
  f2.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await tick();
  const last = w.__HARNESS_CALLS__.slice(before).map((c) => c.cmd);
  check('a slash command while editing is the new text, not a command',
    last.indexOf('matrix_edit') !== -1 && last.indexOf('matrix_send') === -1,
    JSON.stringify(last));
}

// An edit made somewhere else has to land here too.
{
  console.log('\n— edits from elsewhere');
  const { w, d } = await open();
  await w.Chat.openRoom('!snc:matrix.beta.playstructs.com');
  await tick();
  w.__HARNESS_EMIT__('matrix::edited', {
    guild_id: '0-5', room_id: '!snc:matrix.beta.playstructs.com',
    event_id: '$14', body: 'you around? (fixed)',
  });
  await tick();
  const n = d.querySelector('[data-event="$14"]');
  check('the message is rewritten in place', text(n).includes('you around? (fixed)'),
    text(n));
  check('…and marked as changed', !!n.querySelector('.chat-msg-edited'));
  check('…without adding a second message',
    all(d, '[data-event="$14"]').length === 1,
    String(all(d, '[data-event="$14"]').length));

  // Another room must not be repainted by it.
  w.__HARNESS_EMIT__('matrix::edited', {
    guild_id: '0-5', room_id: '!raid:matrix.beta.playstructs.com',
    event_id: '$13', body: 'should not appear',
  });
  await tick();
  check('another room is left alone',
    !text(d.querySelector('#chat-timeline')).includes('should not appear'));
}

// ── Did they see it ────────────────────────────────────────────────────────
// The app has always SENT read receipts — that is what makes the unread
// counts work — but never showed anyone else's, so the question was
// unanswerable from in here.
{
  console.log('\n— read receipts');
  const { w, d } = await open();
  await w.Chat.openRoom('!snc:matrix.beta.playstructs.com');
  await tick();
  check('a room nobody has read shows no line', !d.querySelector('.chat-seen'));

  w.__HARNESS_EMIT__('matrix::seen', {
    guild_id: '0-5', room_id: '!snc:matrix.beta.playstructs.com',
    seen: { event_id: '$mine', names: ['JPEG', 'Netlag'] },
  });
  await tick();
  const line = d.querySelector('.chat-seen');
  check('who has read it is shown', !!line);
  check('…by name', text(line) === 'Seen by JPEG, Netlag', text(line));

  // Three names is a sentence; ten is a list nobody reads.
  w.__HARNESS_EMIT__('matrix::seen', {
    guild_id: '0-5', room_id: '!snc:matrix.beta.playstructs.com',
    seen: { event_id: '$mine', names: ['JPEG', 'Netlag', 'T.Xue', 'Phoniffer', 'Crabla'] },
  });
  await tick();
  check('a crowd is summarised',
    text(d.querySelector('.chat-seen')) === 'Seen by JPEG, Netlag and 3 more',
    text(d.querySelector('.chat-seen')));
  check('…with the full list still available',
    d.querySelector('.chat-seen').title.includes('Crabla'),
    d.querySelector('.chat-seen').title);

  // Another room's receipts must not be reported here.
  w.__HARNESS_EMIT__('matrix::seen', {
    guild_id: '0-5', room_id: '!raid:matrix.beta.playstructs.com',
    seen: { event_id: '$x', names: ['Somebody Else'] },
  });
  await tick();
  check('another room cannot claim this one',
    !text(d.querySelector('.chat-seen')).includes('Somebody Else'),
    text(d.querySelector('.chat-seen')));

  // Leaving takes it with you: a stale "seen by" under a different
  // conversation is a straight lie.
  await w.Chat.openRoom('!raid:matrix.beta.playstructs.com');
  await tick();
  check('changing rooms clears it', !d.querySelector('.chat-seen'),
    String(d.querySelector('.chat-seen') && text(d.querySelector('.chat-seen'))));
}

// ── Shared proof-of-work ───────────────────────────────────────────────────
// A task's grinding input is public — object, kind, anchor — so anyone can
// compute it. Only its owner can submit the answer. That asymmetry is what
// makes asking a room for help safe.
{
  console.log('\n— shared work');
  const { w, d } = await open();
  await w.Chat.openRoom('!snc:matrix.beta.playstructs.com');
  await tick();

  w.__HARNESS_EMIT__('matrix::timeline', {
    guild_id: '0-5', room_id: '!snc:matrix.beta.playstructs.com',
    messages: [{
      event_id: '$w1', sender: '@1-61:h', sender_name: 'JPEG',
      body: 'Work wanted: MINE on 5-2184 (anchor 812004)', kind: 'text', ts: 1,
      work: { kind: 'offer', task: 'MINE', object: '5-2184', target: null,
              block_start: 812004, difficulty: 5 },
    }],
  });
  await tick();
  const card = d.querySelector('.chat-work');
  check('an offer renders as a card', !!card);
  check('…naming the work', text(card).includes('Work wanted') && text(card).includes('Mining'),
    text(card));
  check('…and the struct', text(card).includes('5-2184'), text(card));
  // The anchor is the whole reason a proof goes stale. Showing it is what
  // lets a player see a dead offer as dead.
  check('…and the anchor it is valid against',
    text(card).includes('block 812004'), text(card));

  // A result, and the check that must happen before anything else.
  w.__HARNESS_EMIT__('matrix::timeline', {
    guild_id: '0-5', room_id: '!snc:matrix.beta.playstructs.com',
    messages: [{
      event_id: '$w2', sender: '@1-42:h', sender_name: 'Netlag',
      body: 'Solved 5-2184 MINE @812004: nonce 918273645', kind: 'text', ts: 2,
      work: { kind: 'result', task: 'MINE', object: '5-2184', target: null,
              block_start: 812004, difficulty: 5, nonce: '918273645' },
    }],
  });
  await tick();
  const result = all(d, '.chat-work').pop();
  check('a result renders too', text(result).includes('Solved'), text(result));
  check('…showing the nonce', text(result).includes('918273645'), text(result));

  // Taking on the offer grinds locally. It cannot submit anything: the
  // completion tx names its signer as `creator`, and only the owner's counts.
  card.querySelector('.chat-ref-action')
    .dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await tick();
  const accept = w.__HARNESS_CALLS__.filter((c) => c.cmd === 'matrix_work_accept').pop();
  check('helping starts a local grind', !!accept, JSON.stringify(accept && accept.args));
  check('…against the offer\'s own anchor, not a guessed one',
    accept.args.blockStart === 812004 && accept.args.objectId === '5-2184',
    JSON.stringify(accept.args));
  check('…threaded to the offer it answers', accept.args.offerEvent === '$w1',
    String(accept.args.offerEvent));
  check('…and says the owner still has to submit',
    text(card.querySelector('.chat-work-verdict')).includes('only the owner can submit'),
    text(card.querySelector('.chat-work-verdict')));

  result.querySelector('.chat-ref-action')
    .dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await tick();
  const call = w.__HARNESS_CALLS__.filter((c) => c.cmd === 'matrix_work_verify').pop();
  check('checking it recomputes the hash', !!call, JSON.stringify(call && call.args));
  // Everything but the number is rebuilt from what THIS side knows — a
  // forged result otherwise costs the owner a failed transaction.
  check('…from the task, not from the claim',
    call.args.objectId === '5-2184' && call.args.blockStart === 812004 &&
    call.args.nonce === '918273645',
    JSON.stringify(call.args));
  check('…and says it checks out',
    text(result.querySelector('.chat-work-verdict')).includes('Checks out'),
    text(result.querySelector('.chat-work-verdict')));
  check('…and that the anchor still has to be live',
    text(result.querySelector('.chat-work-verdict')).includes('812004'),
    text(result.querySelector('.chat-work-verdict')));

  // Submitting is a SEPARATE click from checking: it costs the OWNER charge,
  // and one button that both verifies and spends would hide the check at
  // exactly the moment it matters.
  check('a checked proof then offers to be submitted',
    !!result.querySelector('.chat-work-submit'));
  result.querySelector('.chat-work-submit')
    .dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await tick();
  const sub = w.__HARNESS_CALLS__.filter((c) => c.cmd === 'matrix_work_submit').pop();
  check('submitting sends the nonce and the task it solves',
    !!sub && sub.args.nonce === '918273645' && sub.args.objectId === '5-2184' &&
    sub.args.blockStart === 812004,
    JSON.stringify(sub && sub.args));
  check('…and reports it landed',
    text(result.querySelector('.chat-work-verdict')) === 'Submitted.',
    text(result.querySelector('.chat-work-verdict')));
}

// An unchecked result must not offer a submit button at all.
{
  console.log('\n— submit follows checking');
  const { w, d } = await open();
  await w.Chat.openRoom('!snc:matrix.beta.playstructs.com');
  await tick();
  w.__HARNESS_EMIT__('matrix::timeline', {
    guild_id: '0-5', room_id: '!snc:matrix.beta.playstructs.com',
    messages: [{
      event_id: '$w9', sender: '@1-42:h', sender_name: 'Netlag',
      body: 'Solved it', kind: 'text', ts: 9,
      work: { kind: 'result', task: 'MINE', object: '5-2184', target: null,
              block_start: 812004, difficulty: 5, nonce: '918273645' },
    }],
  });
  await tick();
  const card = all(d, '.chat-work').pop();
  check('an unchecked result offers no submit',
    !card.querySelector('.chat-work-submit'), card.innerHTML.slice(-200));
  check('…and no submission has been attempted',
    w.__HARNESS_CALLS__.filter((c) => c.cmd === 'matrix_work_submit').length === 0);
}

// A nonce that does not solve the task must be refused, plainly.
{
  console.log('\n— a bad result');
  const { w, d } = await open();
  w.__HARNESS_WORK_OK__ = false;
  await w.Chat.openRoom('!snc:matrix.beta.playstructs.com');
  await tick();
  w.__HARNESS_EMIT__('matrix::timeline', {
    guild_id: '0-5', room_id: '!snc:matrix.beta.playstructs.com',
    messages: [{
      event_id: '$w3', sender: '@1-9:h', sender_name: 'Scout',
      body: 'Solved it', kind: 'text', ts: 3,
      work: { kind: 'result', task: 'MINE', object: '5-2184', target: null,
              block_start: 812004, difficulty: 5, nonce: '1' },
    }],
  });
  await tick();
  const card = all(d, '.chat-work').pop();
  card.querySelector('.chat-ref-action')
    .dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await tick();
  check('a nonce that does not solve it is refused',
    text(card.querySelector('.chat-work-verdict')).includes('does not solve'),
    text(card.querySelector('.chat-work-verdict')));
  check('…and is not dressed up as a success',
    card.querySelector('.chat-work-verdict').className.includes('chat-mod-bad'),
    card.querySelector('.chat-work-verdict').className);
}

// ── A dead offer ───────────────────────────────────────────────────────────
// A nonce is only valid against the cycle it was ground for. Once that cycle
// turns over the offer is worthless, and a card that still looks live is an
// invitation to spend an hour of GPU on nothing.
{
  console.log('\n— stale work');
  const { w, d } = await open();
  w.__HARNESS_WORK_STALE__ = true;
  await w.Chat.openRoom('!snc:matrix.beta.playstructs.com');
  await tick();
  w.__HARNESS_EMIT__('matrix::timeline', {
    guild_id: '0-5', room_id: '!snc:matrix.beta.playstructs.com',
    messages: [{
      event_id: '$ws', sender: '@1-61:h', sender_name: 'JPEG',
      body: 'Work wanted', kind: 'text', ts: 1,
      work: { kind: 'offer', task: 'MINE', object: '5-2184', target: null,
              block_start: 812004, difficulty: 5 },
    }],
  });
  await tick(); await tick();
  const card = all(d, '.chat-work').pop();
  check('a dead offer is marked', card.className.includes('chat-mod-stale'),
    card.className);
  check('…and says why', text(card).includes('turned over'), text(card));
  // Controls that can only fail are worse than no controls.
  check('…and offers nothing to click', !card.querySelector('.chat-ref-action'),
    card.innerHTML.slice(-160));

  // The check is cached: a busy room is a column of cards and each check is a
  // chain read, and the answer cannot change for a given anchor.
  const asked = w.__HARNESS_CALLS__.filter((c) => c.cmd === 'matrix_work_status').length;
  w.Chat.render();
  w.Chat.render();
  await tick();
  check('the freshness check is asked once, not per render',
    w.__HARNESS_CALLS__.filter((c) => c.cmd === 'matrix_work_status').length === asked,
    String(w.__HARNESS_CALLS__.filter((c) => c.cmd === 'matrix_work_status').length));
}

// An unreadable chain is not a dead offer.
{
  console.log('\n— unknown is not dead');
  const { w, d } = await open();
  w.__HARNESS_WORK_UNKNOWN__ = true;
  await w.Chat.openRoom('!snc:matrix.beta.playstructs.com');
  await tick();
  w.__HARNESS_EMIT__('matrix::timeline', {
    guild_id: '0-5', room_id: '!snc:matrix.beta.playstructs.com',
    messages: [{
      event_id: '$wu', sender: '@1-61:h', sender_name: 'JPEG',
      body: 'Work wanted', kind: 'text', ts: 1,
      work: { kind: 'offer', task: 'MINE', object: '5-2184', target: null,
              block_start: 812004, difficulty: 5 },
    }],
  });
  await tick(); await tick();
  const card = all(d, '.chat-work').pop();
  // Being offline would otherwise make every live offer in the room look
  // dead — a far worse failure than showing one stale card as live.
  check('an unreadable chain leaves the card alone',
    !card.className.includes('chat-mod-stale'), card.className);
  check('…and still offers to help', !!card.querySelector('.chat-ref-action'));
}

// ── Silencing a room ───────────────────────────────────────────────────────
// A noisy room you cannot silence is a room you eventually leave. Muting is
// the alternative: still unread, just not interrupting.
{
  console.log('\n— mute');
  const { w, d } = await open();
  await w.Chat.openRoom('!snc:matrix.beta.playstructs.com');
  await tick();
  const control = () => d.getElementById('chat-room-mute');
  check('a room offers to be silenced', !!control());
  check('…and is not silenced to begin with',
    control().title === 'Silence this room', control().title);

  control().dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await tick();
  const call = w.__HARNESS_CALLS__.filter((c) => c.cmd === 'matrix_mute').pop();
  check('clicking silences it', !!call && call.args.muted === true,
    JSON.stringify(call && call.args));
  check('…and the control now offers the way back',
    control().title.includes('let it speak again'), control().title);

  control().dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await tick();
  check('clicking again lets it speak',
    w.__HARNESS_CALLS__.filter((c) => c.cmd === 'matrix_mute').pop().args.muted === false);
}

// In the list, a silenced room reads differently from a quiet one.
{
  console.log('\n— a silenced room in the list');
  const { w, d } = await open();
  w.__HARNESS_EMIT__('matrix::rooms', {
    guild_id: '0-5',
    rooms: w.__HARNESS_FIXTURES__.matrix_rooms.rooms.map((r) =>
      Object.assign({}, r,
        r.room_id === '!raid:matrix.beta.playstructs.com'
          ? { unread: 4, mention: true, muted: true }
          : (r.room_id === '!ninja:matrix.beta.playstructs.com'
              ? { unread: 2, mention: true } : {}))),
  });
  await tick();

  const rows = all(d, '.sui-result-row');
  const muted = rows.find((n) => n.querySelector('.chat-room-muted'));
  check('a silenced room is marked', !!muted);
  // It is still unread — muting is not reading.
  check('…and still shows its count',
    text(muted.querySelector('.chat-room-unread')) === '4',
    text(muted.querySelector('.chat-room-unread')));
  // …but being named in it no longer pulls the eye, which is the whole point.
  check('…without the mention colour',
    !muted.querySelector('.chat-room-unread').className.includes('sui-mod-warning'),
    muted.querySelector('.chat-room-unread').className);

  // An unmuted room with a mention still does.
  const loud = rows.find((n) => !n.querySelector('.chat-room-muted') &&
    n.querySelector('.chat-room-unread'));
  check('an unsilenced mention still pulls the eye',
    loud.querySelector('.chat-room-unread').className.includes('sui-mod-warning'),
    loud.querySelector('.chat-room-unread').className);
}

// ── A channel list worth reading ───────────────────────────────────────────
// What a channel list is FOR is finding the thing that wants you. In arrival
// order, a room with twelve unread sits below one with none.
{
  console.log('\n— channel order');
  const { w } = await open();
  const order = w.Chat.roomOrder;
  const room = (name, o) => Object.assign({ name: name, unread: 0, mention: false,
    muted: false }, o || {});
  const sort = (list) => list.slice().sort(order).map((r) => r.name).join(',');

  check('being named comes first',
    sort([room('quiet'), room('busy', { unread: 9 }), room('named', { mention: true })])
      === 'named,busy,quiet');
  check('busier before quieter, among what is waiting',
    sort([room('a', { unread: 1 }), room('b', { unread: 9 })]) === 'b,a');
  // Muting means "stop pulling my eye". Sorting a silenced room to the top
  // would undo exactly that, however much traffic it has.
  check('a silenced room never jumps the queue',
    sort([room('loud', { unread: 99, mention: true, muted: true }),
          room('normal', { unread: 1 })]) === 'normal,loud');
  // Read rooms all share a count of zero, so ordering them by it would be an
  // unstable alphabetical pretending to be a ranking.
  check('read rooms are alphabetical',
    sort([room('Zulu'), room('Alpha'), room('Mike')]) === 'Alpha,Mike,Zulu');
}

// Finding one channel among many.
{
  console.log('\n— channel filter');
  const { w, d } = await open();
  const many = [];
  for (let i = 0; i < 14; i++) {
    many.push({ room_id: '!r' + i + ':h', name: 'Room ' + i, icon: 'icon-guild',
      members: 3, joined: true, unread: 0, mention: false, muted: false,
      section: 'local', pinned: [] });
  }
  many.push({ room_id: '!ops:h', name: 'Logistics', icon: 'icon-guild', members: 9,
    joined: true, unread: 0, mention: false, muted: false, section: 'local', pinned: [] });
  w.__HARNESS_EMIT__('matrix::rooms', { guild_id: '0-5', rooms: many });
  await tick();

  const filter = () => d.getElementById('chat-room-filter-q');
  check('a long list offers a filter', !!filter());

  filter().value = 'logi';
  filter().dispatchEvent(new w.Event('input', { bubbles: true }));
  await tick();
  const rows = all(d, '.sui-result-row');
  check('typing narrows it to one', rows.length === 1, String(rows.length));
  check('…the right one', text(rows[0]).includes('Logistics'), text(rows[0]));

  // A filter matching nothing must say so, not show an empty page.
  filter().value = 'zzzz';
  filter().dispatchEvent(new w.Event('input', { bubbles: true }));
  await tick();
  check('a filter matching nothing says so',
    text(d.querySelector('.chat-scroll')).includes('Nothing matches'),
    text(d.querySelector('.chat-scroll')).slice(0, 80));

  // Escape clears it rather than backing out of the view underneath.
  filter().dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await tick();
  check('escape clears the filter', w.Chat._state.roomFilter === '',
    JSON.stringify(w.Chat._state.roomFilter));
  check('…and the list comes back', all(d, '.sui-result-row').length === 15,
    String(all(d, '.sui-result-row').length));
}

// A short list needs no filter at all.
{
  console.log('\n— no filter when it would not help');
  const { d } = await open();
  await tick();
  check('a handful of channels offers no filter box',
    !d.getElementById('chat-room-filter-q'));
}

// ── Jumping to a channel ───────────────────────────────────────────────────
// Typing three letters and pressing Enter is the whole point of a filter;
// reaching for the mouse to finish the job wastes it.
{
  console.log('\n— quick switch');
  const { w, d } = await open();
  const many = [];
  for (let i = 0; i < 12; i++) {
    many.push({ room_id: '!r' + i + ':h', name: 'Room ' + i, icon: 'icon-guild',
      members: 3, joined: true, unread: 0, mention: false, muted: false,
      section: 'local', pinned: [] });
  }
  many.push({ room_id: '!ops:h', name: 'Logistics', icon: 'icon-guild', members: 9,
    joined: true, unread: 0, mention: false, muted: false, section: 'local', pinned: [] });
  w.__HARNESS_EMIT__('matrix::rooms', { guild_id: '0-5', rooms: many });
  await tick();

  const filter = () => d.getElementById('chat-room-filter-q');
  filter().value = 'logi';
  filter().dispatchEvent(new w.Event('input', { bubbles: true }));
  await tick();
  filter().dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await tick();
  check('Enter opens the match', w.Chat._state.roomId === '!ops:h',
    String(w.Chat._state.roomId));
  check('…and clears the filter behind it', w.Chat._state.roomFilter === '',
    JSON.stringify(w.Chat._state.roomFilter));

  // Enter must open the room the EYE sees at the top. Deriving that list
  // twice is how the top row and the one that opens come to disagree.
  w.Chat.go('channels');
  await tick();
  w.__HARNESS_EMIT__('matrix::rooms', {
    guild_id: '0-5',
    rooms: many.map((r) => Object.assign({}, r,
      r.room_id === '!r7:h' ? { unread: 5, mention: true } : {})),
  });
  await tick();
  const firstShown = all(d, '.sui-result-row')[0];
  check('the first row is the one that wants you',
    text(firstShown).includes('Room 7'), text(firstShown));
  check('…and it is what Enter would open',
    w.Chat.filteredRooms()[0].room_id === '!r7:h',
    w.Chat.filteredRooms()[0].room_id);
}

// Ctrl-K from anywhere, including from inside a room.
{
  console.log('\n— ctrl-K');
  const { w, d } = await open();
  await w.Chat.openRoom('!snc:matrix.beta.playstructs.com');
  await tick();
  d.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
  await tick();
  check('ctrl-K goes to the channel list', w.Chat._state.view === 'channels',
    w.Chat._state.view);
  // The fixture has only a handful of rooms, so the filter would normally be
  // hidden — but the shortcut must not focus something that is not there.
  check('…and the filter is there even on a short list',
    !!d.getElementById('chat-room-filter-q'));
  check('…with the cursor already in it',
    d.activeElement.id === 'chat-room-filter-q', d.activeElement.id);

  // Leaving forgets that it was asked for.
  await w.Chat.openRoom('!snc:matrix.beta.playstructs.com');
  await tick();
  w.Chat.go('channels');
  await tick();
  check('a short list goes back to having no filter',
    !d.getElementById('chat-room-filter-q'));
}

// Every placeholder in the window recedes, not an enumerated few.
{
  console.log('\n— placeholders');
  const { d } = await open();
  const rules = Array.from(d.styleSheets)
    .flatMap((s) => { try { return Array.from(s.cssRules); } catch (e) { return []; } })
    .filter((r) => r.selectorText === 'input::placeholder');
  check('one rule covers every input', rules.length === 1,
    String(rules.length));
  // The enumerated version named three ids and was already wrong twice: the
  // channel filter and the message search were both added later.
  check('…and it is the receding one',
    rules[0].style.getPropertyValue('opacity') === '0.45',
    rules[0].style.cssText);
}

// ── A picture is an aside, not the page ────────────────────────────────────
// Only the WIDTH was bounded, which bounds nothing for a tall image: a
// 480x1200 screenshot rendered at 320 wide is 800px of timeline, and the
// conversation goes with it.
{
  console.log('\n— image bounds');
  const { d } = await open();
  const rules = Array.from(d.styleSheets)
    .flatMap((s) => { try { return Array.from(s.cssRules); } catch (e) { return []; } })
    .filter((r) => r.selectorText);
  const box = rules.find((r) => r.selectorText === '.chat-image');
  const img = rules.find((r) => r.selectorText === '.chat-image-img');

  check('an image is bounded on both axes',
    box.style.getPropertyValue('max-width') === '320px' &&
    box.style.getPropertyValue('max-height') === '320px',
    box.style.cssText);
  // Absolute px, not `vh`: the height that matters is the timeline's, and
  // `vh` measures the window — a different number entirely in a scaled or
  // embedded layout, as this harness demonstrates.
  check('…in absolute units, not viewport ones',
    !/vh/.test(box.style.cssText), box.style.cssText);
  // `contain`, never `cover`: cropping somebody's screenshot to fit a box is
  // worse than showing it smaller.
  check('…and scaled to fit rather than cropped',
    img.style.getPropertyValue('object-fit') === 'contain',
    img.style.cssText);
  check('…the image itself capped too, not just its frame',
    img.style.getPropertyValue('max-height') === '320px', img.style.cssText);
}

// ── The connection page ────────────────────────────────────────────────────
// There is deliberately no Sign out: the credential is the key the player is
// already playing with, so signing out would only strand them somewhere they
// cannot chat from. Reconnect is a different thing and does belong.
{
  console.log('\n— connection page');
  const { w, d } = await open();
  w.Chat.go('connection');
  await tick();

  check('a connected session offers a reconnect',
    !!d.getElementById('chat-reconnect'));
  // A session can go bad while still reporting itself signed in, and then
  // there is no failure to retry — so "Try again" never appears and the
  // player is stuck being told everything is fine.
  check('…and not a retry, which there is nothing to retry',
    !d.getElementById('chat-retry'));
  check('…and no sign out, which would only strand them',
    !text(d.querySelector('.chat-page')).toLowerCase().includes('sign out'),
    text(d.querySelector('.chat-page')).slice(0, 60));

  d.getElementById('chat-reconnect')
    .dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await tick();
  const calls = w.__HARNESS_CALLS__.map((c) => c.cmd);
  check('reconnecting drops the session', calls.indexOf('matrix_disconnect') !== -1);
  check('…and takes another straight away',
    calls.lastIndexOf('matrix_connect') > calls.lastIndexOf('matrix_disconnect'),
    JSON.stringify(calls.slice(-4)));

  // Whether other clients can see this player's face renders correctly in
  // here whatever the answer, so this page is the only place the difference
  // is visible at all.
  w.Chat.go('connection');
  await tick();
  check('identity says whether the portrait is published',
    text(d.querySelector('.chat-page')).includes('Published'),
    text(d.querySelector('.chat-page')).slice(0, 200));
}

// A failed sign-in offers the retry instead.
{
  console.log('\n— a failed connection');
  const dom = await JSDOM.fromFile(harness, {
    url: pathToFileURL(harness).href + '?fixture=unauth',
    runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true,
  });
  const w = dom.window;
  await until(() => w.Chat && w.Chat._state && !w.Chat._state.loading);
  w.Chat.go('connection');
  await new Promise((r) => setTimeout(r, 120));
  const d = w.document;
  check('a session that is not connected offers a retry',
    !!d.getElementById('chat-retry'));
  check('…and not a reconnect, which would have nothing to drop',
    !d.getElementById('chat-reconnect'));
}

// ── Browsing for somewhere to go ───────────────────────────────────────────
// A directory in arrival order led with a room that had nobody in it, and
// buried a 3,100-player channel below it.
{
  console.log('\n— browse order');
  const { w, d } = await open();
  const order = w.Chat.browseOrder;
  const r = (name, members, joined) => ({ name: name, members: members, joined: !!joined });
  const sort = (l) => l.slice().sort(order).map((x) => x.name).join(',');

  check('busiest first', sort([r('empty', 0), r('big', 3100), r('small', 4)])
    === 'big,small,empty');
  // A row you are already in answers a question you did not ask.
  check('what you have not joined comes first',
    sort([r('mine', 999, true), r('new', 3)]) === 'new,mine');
  check('…and joined rooms are still ordered among themselves',
    sort([r('a', 1, true), r('b', 50, true)]) === 'b,a');

  // And on screen.
  w.Chat.go('browse');
  await tick(); await tick();
  const rows = all(d, '.sui-result-row');
  check('the directory leads with somewhere worth going',
    !text(rows[0]).includes('0 Players'), text(rows[0]));
  check('…and every row is still there',
    rows.length === w.Chat._state.browse.length,
    rows.length + '/' + w.Chat._state.browse.length);
}

// ── Being asked into a room ────────────────────────────────────────────────
// `rooms.invite` was not read at all, so an invitation produced no row, no
// badge and no notice — indistinguishable from never having been invited.
{
  console.log('\n— invitations');
  const { w, d } = await open();
  const withInvite = w.__HARNESS_FIXTURES__.matrix_rooms.rooms.concat([{
    room_id: '!lobby:crab.la', name: 'Guild Lobby', icon: 'icon-guild',
    members: 0, joined: false, invited: true, invited_by: 'JPEG',
    unread: 0, mention: false, muted: false, section: 'invite', pinned: [],
  }]);
  w.__HARNESS_EMIT__('matrix::rooms', { guild_id: '0-5', rooms: withInvite });
  await tick();

  const rows = all(d, '.sui-result-row');
  const invite = rows.find((n) => text(n).includes('Guild Lobby'));
  check('an invitation is listed', !!invite);
  // First, always: it is the one row waiting on an answer from you rather
  // than reporting something that happened.
  check('…first, above everything else', rows[0] === invite, text(rows[0]));
  // A member count is meaningless for a room you cannot see yet; who asked
  // is the whole basis for deciding.
  check('…saying who asked', text(invite).includes('Invited by JPEG'), text(invite));
  check('…and not pretending to know how many are in it',
    !text(invite).includes('0 Players'), text(invite));

  const btns = [...invite.querySelectorAll('button')].map((b) => b.textContent.trim());
  check('…offering to accept', btns.indexOf('Accept') !== -1, btns.join(','));
  check('…and to decline', btns.indexOf('Decline') !== -1, btns.join(','));

  // A room merely found in the directory has nothing to decline — you were
  // never asked.
  const found = rows.find((n) => n !== invite &&
    [...n.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Join'));
  if (found) {
    check('a directory room offers no decline',
      ![...found.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Decline'),
      [...found.querySelectorAll('button')].map((b) => b.textContent).join(','));
  }

  // Declining removes it at once — waiting for a sync leaves a question on
  // screen that has already been answered.
  [...invite.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Decline')
    .dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await tick();
  const left = w.__HARNESS_CALLS__.filter((c) => c.cmd === 'matrix_leave').pop();
  check('declining turns it down', !!left && left.args.roomId === '!lobby:crab.la',
    JSON.stringify(left && left.args));
  check('…and it leaves the list immediately',
    !all(d, '.sui-result-row').some((n) => text(n).includes('Guild Lobby')));
}

// Accepting goes there, the way joining from the directory does.
{
  console.log('\n— accepting');
  const { w, d } = await open();
  w.__HARNESS_EMIT__('matrix::rooms', {
    guild_id: '0-5',
    rooms: w.__HARNESS_FIXTURES__.matrix_rooms.rooms.concat([{
      room_id: '!raid:matrix.beta.playstructs.com', name: 'Raid', icon: 'icon-raid',
      members: 0, joined: false, invited: true, invited_by: 'Netlag',
      unread: 0, mention: false, muted: false, section: 'invite', pinned: [],
    }]),
  });
  await tick();
  const invite = all(d, '.sui-result-row')[0];
  [...invite.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Accept')
    .dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await tick(); await tick();
  const joined = w.__HARNESS_CALLS__.filter((c) => c.cmd === 'matrix_join').pop();
  check('accepting joins the room', !!joined, JSON.stringify(joined && joined.args));
  check('…and takes you there', w.Chat._state.roomId === '!raid:matrix.beta.playstructs.com',
    String(w.Chat._state.roomId));
}

// ── Finding out what the window can do ─────────────────────────────────────
// Four keyboard affordances were added and none of them was discoverable.
// A shortcut nobody can find is a shortcut nobody uses.
{
  console.log('\n— help');
  const { w, d } = await open();
  await w.Chat.openRoom('!snc:matrix.beta.playstructs.com');
  await tick();
  const input = d.getElementById('chat-input');
  input.value = '/help';
  input.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await tick();
  const out = text(all(d, '.chat-msg').pop());

  check('help lists the commands', out.includes('/whois') && out.includes('/msg'), out.slice(0, 80));
  check('…and the keys', out.includes('Ctrl/Cmd-K') && out.includes('Ctrl/Cmd-F'),
    out.slice(-160));
  check('…including the ones with no visible control',
    out.includes('Tab') && out.includes('Escape'), out.slice(-160));

  // The handler runs from the same table /help prints, so a shortcut cannot
  // exist without being documented or be documented without existing.
  for (const k of w.Chat.SHORTCUTS) {
    check('help documents ' + k.keys, out.includes(k.keys), out.slice(-200));
  }

  // And the ones with a `run` really are bound window-wide.
  const bound = w.Chat.SHORTCUTS.filter((k) => k.run);
  check('every runnable shortcut is bound', bound.length >= 2, String(bound.length));
  d.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
  await tick();
  check('…and Ctrl-K still does what it says',
    w.Chat._state.view === 'channels', w.Chat._state.view);
}

// A line the window says to you is not a message you can react to.
{
  console.log('\n— local lines carry no controls');
  const { w, d } = await open();
  await w.Chat.openRoom('!snc:matrix.beta.playstructs.com');
  await tick();
  const input = d.getElementById('chat-input');
  input.value = '/help';
  input.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await tick();

  const local = all(d, '#chat-timeline .chat-msg').pop();
  check('the help output is the last line', text(local).includes('Ctrl/Cmd-K'),
    text(local).slice(0, 60));
  // `S.reactPicker` is null when no picker is open, and a local line has no
  // server id — so a plain equality made `null === null` true and opened the
  // picker on every notice, error and in-flight message.
  check('a system notice offers no reactions',
    !local.querySelector('.chat-reaction'), local.innerHTML.slice(-200));
  check('…and no reaction picker',
    !local.querySelector('.chat-reaction.chat-mod-offer'));
  check('…nor anything else to click',
    !local.querySelector('.chat-react-btn') && !local.querySelector('.chat-pin-btn'),
    local.innerHTML.slice(-160));

  // A real message still does.
  const real = all(d, '#chat-timeline .chat-msg').find((n) => n.getAttribute('data-event') === '$14');
  check('a real message still offers them', !!real.querySelector('.chat-react-btn'));
}

// ── Who is actually here ───────────────────────────────────────────────────
// Presence is the most social signal Matrix carries and this app discarded it
// entirely. It is also the one that ties Comms to the rest of the app: the
// roster lists who EXISTS, this says who is AROUND.
{
  console.log('\n— presence');
  const { w, d } = await open();
  w.Chat.go('channels');
  await tick();

  const dm = all(d, '.sui-result-row').find((n) => text(n).includes('JPEG'));
  check('a direct message shows whether they are here',
    !!dm.querySelector('.chat-presence'), dm.innerHTML.slice(0, 200));
  check('…online, when they are',
    dm.querySelector('.chat-presence').className.includes('chat-mod-online'),
    dm.querySelector('.chat-presence').className);

  // Idle is a real state with its own word in the spec (`unavailable`), and
  // it means something different from away.
  const dot = w.Chat.presenceDot('1-42');
  check('idle is its own state', dot && dot.className.includes('chat-mod-idle'),
    dot && dot.className);
  check('…and says so in words', dot.title === 'Idle', dot.title);

  // Silence is not offline. Somebody the server has said nothing about draws
  // nothing at all.
  check('an unknown player draws no dot', w.Chat.presenceDot('1-999') === null);
  check('…and neither does a room that is not a person',
    w.Chat.presenceDot(null) === null);

  // A live update repaints.
  w.__HARNESS_EMIT__('matrix::presence', {
    guild_id: '0-5', presence: { '1-61': { state: 'offline' } },
  });
  await tick();
  const after = all(d, '.sui-result-row').find((n) => text(n).includes('JPEG'));
  check('going away updates the dot',
    after.querySelector('.chat-presence').className.includes('chat-mod-away'),
    after.querySelector('.chat-presence').className);
}

// A homeserver with presence turned off must show nothing, not a dead guild.
{
  console.log('\n— presence disabled');
  const dom = await JSDOM.fromFile(harness, {
    url: pathToFileURL(harness).href,
    runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true,
    beforeParse(window) { window.__HARNESS_NO_PRESENCE__ = true; },
  });
  const w = dom.window;
  await until(() => w.Chat && w.Chat._state && !w.Chat._state.loading);
  await new Promise((r) => setTimeout(r, 150));
  const d = w.document;
  // Many Synapse deployments turn presence off because it is expensive at
  // scale. A wall of grey dots implying nobody is here is worse than none.
  check('no dots at all when the server does not run presence',
    d.querySelectorAll('.chat-presence').length === 0,
    String(d.querySelectorAll('.chat-presence').length));
  check('…and the rooms are still listed',
    all(d, '.sui-result-row').length > 0,
    String(all(d, '.sui-result-row').length));
}

// ── Saying what you are doing ──────────────────────────────────────────────
// The other half of presence. Synapse marks an account online on its own
// while it syncs, so this is not about being visible — it is about the STATUS
// LINE, which in a game about raiding each other is tactical.
{
  console.log('\n— sharing your activity');
  const { w, d } = await open();
  w.Chat.go('connection');
  await tick();
  const page = () => text(d.querySelector('.chat-page'));

  // Off unless asked for. Nothing about what you are doing leaves the machine
  // until the player says so.
  check('activity is not shared by default', page().includes('Not shared'), page().slice(0, 200));
  const btn = all(d, '.chat-ref-action').find((n) => text(n) === 'Share');
  check('…and there is a way to turn it on', !!btn);
  // The control must say what turning it on would reveal.
  check('…which says what it would reveal',
    btn.title.includes('fleet is away') && btn.title.includes('undefended'),
    btn.title);

  btn.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await tick();
  const call = w.__HARNESS_CALLS__.filter((c) => c.cmd === 'matrix_status_sharing').pop();
  check('turning it on tells Rust', !!call && call.args.enabled === true,
    JSON.stringify(call && call.args));
  check('…and the page then shows what is being said',
    page().includes('Fleet away'), page().slice(0, 220));
  check('…and offers the way back',
    !!all(d, '.chat-ref-action').find((n) => text(n) === 'Stop sharing'));
}

// Other people's status, where their name already is.
{
  console.log('\n— what others are doing');
  const { w, d } = await open();
  await w.Chat.openRoom('!snc:matrix.beta.playstructs.com');
  await tick();
  w.Chat.go('members');
  await tick(); await tick();

  const rows = all(d, '.sui-result-row');
  const said = rows.find((n) => text(n).includes('On station'));
  check('somebody who says what they are doing shows it', !!said,
    rows.map((n) => text(n)).join(' | ').slice(0, 160));
  // Most people will not have set one, so the id stays the fallback rather
  // than the row going blank.
  const quiet = rows.find((n) => text(n).includes('PID #'));
  check('…and everyone else still shows their id', !!quiet,
    rows.map((n) => text(n)).join(' | ').slice(0, 160));
}

// ── Threads ────────────────────────────────────────────────────────────────
// Element threads heavily and every threaded message carries a compatibility
// `m.in_reply_to`. Rendering that as a reply quotes somebody who was never
// answered.
{
  console.log('\n— threads');
  const { w, d } = await open();
  await w.Chat.openRoom('!snc:matrix.beta.playstructs.com');
  await tick();
  w.__HARNESS_EMIT__('matrix::timeline', {
    guild_id: '0-5', room_id: '!snc:matrix.beta.playstructs.com',
    messages: [{
      event_id: '$th1', sender: '@1-61:h', sender_name: 'JPEG',
      body: 'agreed', kind: 'text', ts: 1, thread_root: '$14',
    }],
  });
  await tick();
  const msg = all(d, '#chat-timeline .chat-msg').pop();
  check('a threaded message says it is in a thread',
    text(msg).includes('In a thread'), text(msg));
  check('…marked as a thread, not as a reply',
    msg.querySelector('.chat-mod-thread') !== null, msg.innerHTML.slice(0, 200));
  check('…and quotes nobody', !text(msg).includes('T.Xue'), text(msg));

  msg.querySelector('.chat-reply-quote')
    .dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await tick();
  check('clicking it goes to what the thread is about',
    d.querySelector('[data-event="$14"]').className.includes('chat-mod-found'),
    d.querySelector('[data-event="$14"]').className);

  // A genuine reply inside a thread still shows its quote — the sender chose
  // that one.
  w.__HARNESS_EMIT__('matrix::timeline', {
    guild_id: '0-5', room_id: '!snc:matrix.beta.playstructs.com',
    messages: [{
      event_id: '$th2', sender: '@1-61:h', sender_name: 'JPEG',
      body: 'the second', kind: 'text', ts: 2, thread_root: '$14',
      reply_to: '$14', reply_sender: '@1-77:matrix.beta.playstructs.com',
      reply_excerpt: 'you around?',
    }],
  });
  await tick();
  const replied = all(d, '#chat-timeline .chat-msg').pop();
  check('a real reply in a thread keeps its quote',
    text(replied).includes('you around?'), text(replied));
  check('…and is not marked twice',
    replied.querySelectorAll('.chat-reply-quote').length === 1,
    String(replied.querySelectorAll('.chat-reply-quote').length));
}

// ── Encrypted rooms ────────────────────────────────────────────────────────
// Element makes direct messages encrypted by DEFAULT and this client has no
// crypto, so this is the common case, not a corner.
{
  console.log('\n— encrypted rooms');
  const { w, d } = await open();
  w.__HARNESS_TIMELINE__ = {
    room: { room_id: '!enc:h', name: 'JPEG', encrypted: true, joined: true,
            members: 2, section: 'direct', pinned: [] },
    messages: [{ event_id: '$e1', sender: '@1-61:h', sender_name: 'JPEG',
                 kind: 'notice', ts: 1,
                 body: 'encrypted message — this app cannot read it' }],
  };
  await w.Chat.openRoom('!enc:h');
  await tick();

  const page = text(d.querySelector('.chat-page'));
  check('an encrypted room says so once, at the top',
    !!d.querySelector('.chat-encrypted'), page.slice(0, 120));
  // The player needs to know it is not broken, and what to do instead.
  check('…explaining that this app cannot read it',
    page.includes('cannot read it'), page.slice(0, 200));
  check('…and what would', page.includes('Matrix client with encryption'),
    page.slice(0, 240));

  // Each message is still honest about itself, and NOT the old nonsense.
  const msg = all(d, '#chat-timeline .chat-msg').pop();
  check('an encrypted message reads as one', text(msg).includes('encrypted message'),
    text(msg));
  check('…and not as "changed encrypted"', !text(msg).includes('changed'), text(msg));

  // A normal room shows no such banner.
  w.__HARNESS_TIMELINE__ = null;
  await w.Chat.openRoom('!snc:matrix.beta.playstructs.com');
  await tick();
  check('a readable room says nothing about encryption',
    !d.querySelector('.chat-encrypted'));
}

// ── An upgraded room ───────────────────────────────────────────────────────
// Changing a room's version is a normal admin action. The old room stays
// joinable, stays in the list and stays open — so without following the
// tombstone a player goes on talking into a room everyone else has left.
{
  console.log('\n— room upgrades');
  const { w, d } = await open();
  w.__HARNESS_TIMELINE__ = {
    room: { room_id: '!old:h', name: 'SN.Corporation', joined: true, members: 25,
            section: 'local', pinned: [], replaced_by: '!new:h' },
    messages: [{ event_id: '$t', sender: '@1-61:h', sender_name: 'JPEG',
                 kind: 'notice', ts: 1,
                 body: 'this room has been replaced — the conversation continues elsewhere' }],
  };
  await w.Chat.openRoom('!old:h');
  await tick();

  const moved = d.querySelector('.chat-mod-moved');
  check('a replaced room says so', !!moved, text(d.querySelector('.chat-page')).slice(0, 120));
  check('…in plain terms', text(moved).includes('conversation continues'), text(moved));
  // A notice with no way forward would leave the player to hunt for a room
  // they have never been in.
  const go = [...moved.querySelectorAll('a')].find((n) => text(n) === 'Go there');
  check('…and offers the way there', !!go);

  go.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await tick(); await tick();
  const joined = w.__HARNESS_CALLS__.filter((c) => c.cmd === 'matrix_join').pop();
  // Joining first: an upgraded room is usually one this account has never
  // been in, and opening it without joining shows an empty screen that looks
  // like the upgrade lost the history.
  check('going there joins the replacement first',
    !!joined && joined.args.roomId === '!new:h', JSON.stringify(joined && joined.args));
  check('…and then opens it', w.Chat._state.roomId === '!new:h',
    String(w.Chat._state.roomId));

  // A living room says nothing of the sort.
  w.__HARNESS_TIMELINE__ = null;
  await w.Chat.openRoom('!snc:matrix.beta.playstructs.com');
  await tick();
  check('a room that has not moved shows no notice', !d.querySelector('.chat-mod-moved'));
}

// ── A break in the record ──────────────────────────────────────────────────
// `limited: true` is the server saying it truncated the batch — messages
// exist between what we hold and what arrived. It happens after any
// reconnect. Appending regardless stitches two ends of a conversation
// together as though nothing were missing.
{
  console.log('\n— missing messages');
  const { w, d } = await open();
  await w.Chat.openRoom('!snc:matrix.beta.playstructs.com');
  await tick();
  const before = all(d, '#chat-timeline .chat-msg').length;

  w.__HARNESS_EMIT__('matrix::timeline', {
    guild_id: '0-5', room_id: '!snc:matrix.beta.playstructs.com',
    messages: [
      { event_id: 'gap:!snc:t1', kind: 'gap', body: 'some messages are missing', ts: 0 },
      { event_id: '$after', sender: '@1-61:h', sender_name: 'JPEG',
        body: 'back again', kind: 'text', ts: 1787900700000 },
    ],
  });
  await tick();

  const rules = all(d, '.chat-rule');
  const gap = rules.find((n) => text(n).includes('some messages are missing'));
  check('a gap is drawn across the timeline', !!gap,
    rules.map((n) => text(n)).join(' | '));
  // It is not something anyone said, so it must not look like a message.
  check('…as a rule, not as a message',
    all(d, '#chat-timeline .chat-msg').length === before + 1,
    (all(d, '#chat-timeline .chat-msg').length - before) + ' new messages');
  check('…and it is marked, not a quiet date separator',
    gap.className.includes('chat-mod-alert'), gap.className);
  check('…with the message that followed it still shown',
    text(d.querySelector('#chat-timeline')).includes('back again'));
  // A gap has no time — it is a hole, not a moment. Dating it to its `ts` of
  // 0 printed "31 Dec 1969" above every break in the record.
  check('…and no date is invented for it',
    !text(d.querySelector('#chat-timeline')).includes('1969'),
    text(d.querySelector('#chat-timeline')).slice(-160));
  check('…nor for the message straight after it',
    rules.filter((n) => /19\d\d|20\d\d/.test(text(n))).length <= 1,
    rules.map((n) => text(n)).join(' | '));
}

// ── When nothing is arriving ───────────────────────────────────────────────
// The sync loop recovers on its own, but until it does, a window with nothing
// arriving looks exactly like a quiet guild. A stall that presents as calm is
// the worst failure a chat client has.
{
  console.log('\n— sync stalled');
  const { w, d } = await open();
  await w.Chat.openRoom('!snc:matrix.beta.playstructs.com');
  await tick();
  check('a healthy window says nothing about sync',
    !d.querySelector('.chat-mod-stalled'));

  w.__HARNESS_EMIT__('matrix::sync_health', {
    guild_id: '0-5', ok: false, reason: 'connection refused',
  });
  await tick();
  const bar = d.querySelector('.chat-mod-stalled');
  check('a stall is announced', !!bar, text(d.querySelector('.chat-page')).slice(0, 80));
  check('…saying it is still trying', text(bar).includes('trying again'), text(bar));
  check('…and why', text(bar).includes('connection refused'), text(bar));

  // A stall is not about one conversation, so leaving the room must not hide
  // it — that would look like the problem went away.
  w.Chat.go('channels');
  await tick();
  check('it follows you out of the room', !!d.querySelector('.chat-mod-stalled'));

  // Recovery clears it without being asked.
  w.__HARNESS_EMIT__('matrix::sync_health', { guild_id: '0-5', ok: true });
  await tick();
  check('recovering clears it', !d.querySelector('.chat-mod-stalled'));

  // Another guild's trouble is not this one's.
  w.__HARNESS_EMIT__('matrix::sync_health', {
    guild_id: '0-1', ok: false, reason: 'elsewhere',
  });
  await tick();
  check('another network cannot raise it here', !d.querySelector('.chat-mod-stalled'));
}

// ── A message that would not send ──────────────────────────────────────────
// The commonest failure a player meets — a rate limit, a dropped connection.
// The error used to be appended to the message body, so the player's own
// words came entangled with a diagnostic and there was nothing to retry.
{
  console.log('\n— failed sends');
  const { w, d } = await open();
  await w.Chat.openRoom('!snc:matrix.beta.playstructs.com');
  await tick();

  w.__HARNESS_REJECT__.matrix_send =
    'the homeserver is rate limiting this; try again in 3s';
  const input = d.getElementById('chat-input');
  input.value = 'raid 2-15361 at dawn';
  input.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await tick(); await tick();

  const failed = all(d, '#chat-timeline .chat-msg').pop();
  // The words are the player's, and must survive intact.
  check('the message keeps exactly what was written',
    text(failed.querySelector('.chat-msg-body')) === 'raid 2-15361 at dawn',
    text(failed.querySelector('.chat-msg-body')));
  check('…with the reason beside it, not inside it',
    text(failed.querySelector('.chat-send-failed-why')).includes('rate limiting'),
    text(failed));
  check('…and a way to send it again',
    !!Array.from(failed.querySelectorAll('a')).find((n) => text(n) === 'Try again'));

  // Retrying sends the original text, not the text plus an error.
  w.__HARNESS_REJECT__.matrix_send = null;
  delete w.__HARNESS_REJECT__.matrix_send;
  Array.from(failed.querySelectorAll('a')).find((n) => text(n) === 'Try again')
    .dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await tick(); await tick();

  const sent = w.__HARNESS_CALLS__.filter((c) => c.cmd === 'matrix_send').pop();
  check('retrying sends what was written', sent.args.body === 'raid 2-15361 at dawn',
    JSON.stringify(sent.args.body));
  // Leaving the failed echo would put the same words on screen twice.
  check('…and the failed copy is gone',
    all(d, '#chat-timeline .chat-msg')
      .filter((n) => text(n).includes('raid 2-15361 at dawn')).length === 1,
    String(all(d, '#chat-timeline .chat-msg')
      .filter((n) => text(n).includes('raid 2-15361 at dawn')).length));
  check('…and it is no longer marked failed',
    !all(d, '#chat-timeline .chat-msg').pop().className.includes('chat-msg-failed'),
    all(d, '#chat-timeline .chat-msg').pop().className);
}

console.log(failures ? `\n${failures} failing check(s)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
