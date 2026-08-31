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
/* Does any rule in the document hide this element AS IT IS RIGHT NOW?
 *
 * The failure this guards is a `classList.toggle('hidden')` on an element no
 * stylesheet covers: the class lands, nothing moves, and the control stays on
 * screen. Matching the element against each rule's own selector — rather than
 * looking for a selector string the test knows — means the check cannot pass
 * by agreeing with a copy of the code.
 */
function hidesElement(el) {
  for (const sheet of el.ownerDocument.styleSheets) {
    let rules;
    try { rules = sheet.cssRules; } catch { continue; }
    for (const rule of rules || []) {
      if (!rule.selectorText || !rule.style || rule.style.display !== 'none') continue;
      try { if (el.matches(rule.selectorText)) return true; } catch { /* :has etc. */ }
    }
  }
  return false;
}
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
  // ALWAYS OPEN. Collapsed, the rail was a tall empty column holding a "show"
  // link — a worse use of the space than the conversation it was hiding.
  check('…which is not collapsible', !panel.classList.contains('rv-collapsed'));
  check('…and there is no show/hide toggle', d.getElementById('rv-chat-toggle') === null);

  await new Promise((r) => setTimeout(r, 120));
  const call = w.__HARNESS_CALLS__.filter((c) => c.cmd === 'matrix_object_chatter').pop();
  check('it asks what was said without being opened',
    !!call && call.args.objectId === '2-1', JSON.stringify(call && call.args));
  // `.chat-msg` — the Comms window's own row class. The rail used to build
  // its own `.rv-chat-row` lookalike; it now draws the shared component from
  // `chatrow.js`, so the selector is the real one.
  const rows = d.querySelectorAll('.chat-msg');
  check('…and shows it', rows.length === 1, String(rows.length));
  // Read through a default rather than indexing: "no rows at all" is a case
  // these very checks exist to catch, and `rows[0].textContent` turns it into
  // a TypeError that ends the run instead of a failure that names itself.
  const first = (rows[0] || {}).textContent || '';
  check('…with who said it',
    first.includes('JPEG') && first.includes('shield on 2-1'), first);
  // Which room it was said in is the part you cannot infer.
  check('…and where', first.includes('SN.Corporation'), first);

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
  // Trimmed, AND tagged with the planet: the rail finds its messages by
  // searching for the object id, so one that does not name the planet is sent
  // successfully and then never appears here.
  check('…trimmed and tagged with the planet',
    !!sent && sent.args.body === 'they are down to one shield 2-1',
    JSON.stringify(sent && sent.args.body));
  check('…and the box is cleared so it cannot be sent twice', input.value === '');

  // ── A slash means the same thing here as in Comms ──────────────────────
  // The rail has no commands. What matters is that it does not PUBLISH one:
  // Comms answers `/foo` with "unknown command", and a rail that just sent it
  // would post the player's mistake to the guild.
  {
    const err = d.getElementById('rv-chat-error');
    const sends = () => w.__HARNESS_CALLS__.filter((c) => c.cmd === 'matrix_send');

    const before = sends().length;
    input.value = '/sweep all';
    d.getElementById('rv-chat-send').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 40));
    check('an unknown command is not posted to the room', sends().length === before);
    check('…and says where commands live', /Comms/.test(err.textContent), err.textContent);

    input.value = '/me is out of charge';
    d.getElementById('rv-chat-send').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 40));
    let last = sends().pop();
    check('/me is an emote, as it is in Comms',
      !!last && last.args.body === 'is out of charge 2-1' && last.args.msgtype === 'm.emote',
      JSON.stringify(last && last.args));

    // The escape exists precisely so someone can say "/me waves" literally.
    // It is checked BEFORE /me, or it would be defeated by the thing it
    // escapes — and it is why this parsing cannot live server-side.
    input.value = '//me waves';
    d.getElementById('rv-chat-send').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 40));
    last = sends().pop();
    check('a doubled slash sends the literal text, not an emote',
      !!last && last.args.body === '/me waves 2-1' && !last.args.msgtype,
      JSON.stringify(last && last.args));

    // Ordinary text is untouched by any of this.
    input.value = 'they are down to one shield';
    d.getElementById('rv-chat-send').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 40));
    last = sends().pop();
    check('a message with no slash keeps its text',
      !!last && last.args.body === 'they are down to one shield 2-1' && !last.args.msgtype,
      JSON.stringify(last && last.args));

    // Already named? Then it is not named twice.
    input.value = 'watch 2-1 closely';
    d.getElementById('rv-chat-send').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 40));
    last = sends().pop();
    check('…and a planet already named is not repeated',
      !!last && last.args.body === 'watch 2-1 closely',
      JSON.stringify(last && last.args.body));
  }

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

  // The rail is always open, so a message about this planet REFETCHES rather
  // than marking a badge nobody would see.
  const before = w.__HARNESS_CALLS__.filter((c) => c.cmd === 'matrix_object_chatter').length;
  w.__HARNESS_EMIT__('matrix::timeline', {
    guild_id: '0-5', room_id: '!snc:h',
    messages: [{ event_id: '$n1', sender: '@1-61:h', body: 'shield on 2-1 is down', kind: 'text' }],
  });
  await new Promise((r) => setTimeout(r, 150));
  check('a message about this planet refreshes the rail',
    w.__HARNESS_CALLS__.filter((c) => c.cmd === 'matrix_object_chatter').length > before);

  // A message about a DIFFERENT planet must not touch it at all.
  const before2 = w.__HARNESS_CALLS__.filter((c) => c.cmd === 'matrix_object_chatter').length;
  w.__HARNESS_EMIT__('matrix::timeline', {
    guild_id: '0-5', room_id: '!snc:h',
    messages: [{ event_id: '$n2', sender: '@1-61:h', body: 'raiding 2-15361', kind: 'text' }],
  });
  await new Promise((r) => setTimeout(r, 150));
  check('another planet does not refresh this one',
    w.__HARNESS_CALLS__.filter((c) => c.cmd === 'matrix_object_chatter').length === before2);

  // The count is now just how many lines are on screen, not a "you missed
  // something" badge — there is no closed state to miss anything in.
  check('the count reports what is displayed',
    d.getElementById('rv-chat-count').textContent
      === String(d.querySelectorAll('.chat-msg').length || ''),
    d.getElementById('rv-chat-count').textContent);
}

// ── The object's own room ───────────────────────────────────────────────────
//
// The rail has two ways to get messages and they must not behave the same.
// Searching every room for the planet's id is the fallback for a planet on
// somebody else's homeserver; a room per planet is the real thing. The tests
// below pin what changes when the real thing exists — because the difference
// is exactly the id-tagging workaround the search path needs and the room
// path must not do.
{
  const d = w.document;
  const chat = RV._chat;
  const before = JSON.stringify({ room: chat.room, rows: chat.rows.length });

  check('with no room of its own, the rail is not "in" one',
    RV._inRoom() === false && RV._reachableRoom() === false, before);

  // A room that exists but we have not joined is REACHABLE, not entered:
  // sending is what buys the membership.
  chat.room = { connected: true, guild_id: '0-5', alias: '#planet-2-1:h',
                room_id: '!planet-2-1:h', can_create: false, joined: false };
  check('an unjoined room is reachable but not entered',
    RV._reachableRoom() === true && RV._inRoom() === false);

  // Likewise a room that does not exist yet but is ours to make.
  chat.room = { connected: true, guild_id: '0-5', alias: '#planet-2-1:h',
                room_id: null, can_create: true, joined: false };
  check('a creatable room is reachable but not entered',
    RV._reachableRoom() === true && RV._inRoom() === false);

  chat.room = { connected: true, guild_id: '0-5', alias: '#planet-2-1:h',
                room_id: '!planet-2-1:h', can_create: false, joined: true };
  check('a joined room is entered', RV._inRoom() === true);

  // The composer must stop offering a room to choose. The choice only exists
  // because the search path has to guess; a room per planet has answered it,
  // and offering it again invites sending the planet's talk elsewhere.
  chat.connected = true; chat.guildId = '0-5';
  RV._syncComposer();
  const sel = d.getElementById('rv-chat-room');
  const input = d.getElementById('rv-chat-input');
  check('the room selector is hidden inside the object room',
    sel.classList.contains('hidden'));
  // Not `getComputedStyle`: jsdom answered 'none' for this control even with
  // the rule deleted, so it proved nothing. Ask the question directly — is
  // there a rule in the page that MATCHES this element and hides it? That is
  // the actual bug class, a class toggle with no rule behind it, and it is
  // asked without naming the selector the code uses.
  check('...and a rule in the page actually hides it', hidesElement(sel));
  check('the placeholder stops promising an appended id',
    !/id is added/.test(input.placeholder), input.placeholder);

  // And it comes back when there is no room — the fallback must still work.
  chat.room = null;
  RV._syncComposer();
  check('the selector returns on the search path', !sel.classList.contains('hidden'));
  check('...and the placeholder admits the id is appended',
    /id is added/.test(input.placeholder), input.placeholder);

  // A message in the object's own room refreshes the rail even though it
  // never names the planet — belonging, not naming, is the test in there.
  chat.room = { connected: true, guild_id: '0-5', alias: '#planet-2-1:h',
                room_id: '!planet-2-1:h', can_create: false, joined: true };
  const n0 = w.__HARNESS_CALLS__.filter((c) => c.cmd === 'matrix_timeline').length;
  w.__HARNESS_EMIT__('matrix::timeline', {
    guild_id: '0-5', room_id: '!planet-2-1:h',
    messages: [{ event_id: '$q1', sender: '@1-61:h', body: 'no id here', kind: 'text' }],
  });
  await until(() =>
    w.__HARNESS_CALLS__.filter((c) => c.cmd === 'matrix_timeline').length > n0, 2000);
  check('an unnamed message in the object room still refreshes it',
    w.__HARNESS_CALLS__.filter((c) => c.cmd === 'matrix_timeline').length > n0);

  // ...and its body is rendered verbatim, with no id bolted on.
  const bodies = [...d.querySelectorAll('.chat-msg-body')].map((e) => e.textContent);
  check('room messages render without an appended id',
    bodies.includes('shield is down'), bodies.join(' | '));

  // A message in a DIFFERENT room must not, or every room in the guild
  // repaints a panel about one planet.
  const n1 = w.__HARNESS_CALLS__.filter((c) => c.cmd === 'matrix_timeline').length;
  w.__HARNESS_EMIT__('matrix::timeline', {
    guild_id: '0-5', room_id: '!general:h',
    messages: [{ event_id: '$q2', sender: '@1-61:h', body: 'unrelated', kind: 'text' }],
  });
  await new Promise((r) => setTimeout(r, 150));
  check('another room does not refresh the object room',
    w.__HARNESS_CALLS__.filter((c) => c.cmd === 'matrix_timeline').length === n1);
}

// ── What actually goes on the wire ─────────────────────────────────────────
//
// The id-tagging workaround is a SEND-time behaviour, so only a send can
// prove it stopped. Rendering the fixture proves nothing about it.
{
  const d = w.document;
  const chat = RV._chat;
  const input = d.getElementById('rv-chat-input');
  const send = d.getElementById('rv-chat-send');
  const sends = () => w.__HARNESS_CALLS__.filter((c) => c.cmd === 'matrix_send');

  async function say(text) {
    const n = sends().length;
    input.value = text;
    chat.sending = false;
    send.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await until(() => sends().length > n, 2000);
    return sends()[sends().length - 1];
  }

  // Searching: the id has to be appended or the rail cannot find its own
  // message. This is the behaviour that must survive.
  chat.room = null;
  chat.connected = true; chat.guildId = '0-5'; chat.roomId = '!snc:h';
  const searched = await say('shield is down');
  check('on the search path the id is appended',
    searched && searched.args.body === 'shield is down 2-1',
    searched && searched.args.body);

  // In the object's own room it must NOT be: the message belongs by where it
  // was sent, and an appended id is noise the player did not type.
  chat.room = { connected: true, guild_id: '0-5', alias: '#planet-2-1:h',
                room_id: '!planet-2-1:h', can_create: false, joined: true };
  const inRoomSend = await say('shield is down');
  check('in the object room the id is NOT appended',
    inRoomSend && inRoomSend.args.body === 'shield is down',
    inRoomSend && inRoomSend.args.body);
  check('...and it goes to the object room, not the picked room',
    inRoomSend && inRoomSend.args.roomId === '!planet-2-1:h',
    inRoomSend && inRoomSend.args.roomId);

  // A room we have not joined: speaking is what joins us, so the join must
  // happen BEFORE the send or the send is rejected for non-membership.
  chat.room = { connected: true, guild_id: '0-5', alias: '#planet-2-1:h',
                room_id: null, can_create: true, joined: false };
  const nCreate = w.__HARNESS_CALLS__.filter(
    (c) => c.cmd === 'matrix_object_room_create').length;
  const joined = await say('opening this up');
  check('speaking joins-or-creates the room first',
    w.__HARNESS_CALLS__.filter((c) => c.cmd === 'matrix_object_room_create').length
      === nCreate + 1);
  check('...and the message lands in it, untagged',
    joined && joined.args.roomId === '!planet-2-1:h'
      && joined.args.body === 'opening this up',
    joined && joined.args.roomId + ' / ' + joined.args.body);

  // Ordering, explicitly: a send that raced ahead of its join would fail on
  // the real server and pass a test that only counted calls.
  const order = w.__HARNESS_CALLS__.map((c) => c.cmd)
    .filter((c) => c === 'matrix_object_room_create' || c === 'matrix_send');
  check('the join precedes the send it enabled',
    order[order.length - 2] === 'matrix_object_room_create'
      && order[order.length - 1] === 'matrix_send', order.slice(-3).join(' → '));

  // `/me` still means emote and `//` still escapes, in a room as much as in a
  // search — the rail must not quietly change what typing means.
  const emote = await say('/me watches the shield');
  check('/me is still an emote in the object room',
    emote && emote.args.msgtype === 'm.emote'
      && emote.args.body === 'watches the shield',
    emote && emote.args.msgtype + ' / ' + emote.args.body);
}

// ── Telling the two panels apart ───────────────────────────────────────────
//
// They look the same and behave differently — one appends an id to what you
// type, the other does not. If the panel does not say which it is, a player
// cannot tell why their message did or did not appear.
{
  const d = w.document;
  const chat = RV._chat;
  const title = () => d.querySelector('.rv-chat-title').textContent;

  chat.room = null;
  chat.connected = true; chat.guildId = '0-5';
  chat.rows = [{ room_id: '!snc:h', room_name: 'SN.Corporation',
                 message: { sender_name: 'JPEG', body: 'shield on 2-1 down' } }];
  RV._renderChat();
  check('searching is labelled Comms', title() === 'Comms', title());
  check('...and each row says which room it came from',
    [...d.querySelectorAll('.rv-chat-room')].some((e) => e.textContent === 'SN.Corporation'));

  chat.room = { connected: true, guild_id: '0-5', room_id: '!planet-2-1:h', joined: true };
  chat.roomName = 'Planet 2-1';
  RV._renderChat();
  check('the object room is named in the title', title() === 'Planet 2-1', title());
  check('...and the per-row room label stops repeating it',
    [...d.querySelectorAll('.rv-chat-room')].every((e) => e.textContent === ''));

  // The empty state must not call a fleet a planet. This window opens on both.
  chat.rows = [];
  RV._renderChat();
  check('the empty line names the right kind of object',
    /this planet yet/.test(d.getElementById('rv-chat-body').textContent),
    d.getElementById('rv-chat-body').textContent);
  // Both branches, not just the one this harness window happens to be. The
  // fleet case is the one that was wrong, and a planet-only window can never
  // catch it.
  check('...and a fleet window would say fleet',
    RV._objectWord('fleet') === 'fleet' && RV._objectWord('planet') === 'planet'
      && RV._objectWord(undefined) === 'planet',
    [RV._objectWord('fleet'), RV._objectWord('planet')].join('/'));
}

// ── The rail is the Comms row, not a lookalike ─────────────────────────────
//
// Asked for twice, the second time as "why does it need to be styled in a
// unique way". The first answer mirrored the styling, which is how the two
// drifted apart again. This asserts the actual thing: one component, drawn by
// both windows.
{
  const d = w.document;
  const chat = RV._chat;

  chat.connected = true; chat.guildId = '0-5';
  chat.room = { connected: true, guild_id: '0-5', room_id: '!p:h', joined: true };
  chat.roomName = 'Planet 2-1';
  const t0 = Date.now();
  chat.rows = [
    { room_id: '!p:h', message: { event_id: '$e1', sender: '@1-194:h', sender_name: 'Marklifer',
        kind: 'event', ts: t0, body: 'joined' } },
    { room_id: '!p:h', message: { event_id: '$m1', sender: '@1-61:h', sender_name: 'JPEG',
        sender_tag: 'SN.C', kind: 'text', ts: t0 + 1000, body: 'shield is down' } },
    { room_id: '!p:h', message: { event_id: '$m2', sender: '@1-61:h', sender_name: 'JPEG',
        sender_tag: 'SN.C', kind: 'text', ts: t0 + 2000, body: 'moving in' } },
    { room_id: '!p:h', message: { event_id: '$m3', sender: '@1-194:h', sender_name: 'Marklifer',
        kind: 'emote', ts: t0 + 3000, body: 'watches' } },
  ];
  RV._renderChat();

  // A room event is not conversation. The rail used to render "joined" as
  // though somebody had said it.
  /* `txt()` rather than `querySelector(...).textContent`.
   *
   * A missing element is exactly what these checks are for, and dereferencing
   * null turns that into a TypeError that kills the run — which reports as a
   * crash, not as a failure. The same ambiguity bites a mutation run: it
   * cannot tell "the guard worked" from "the harness broke".
   */
  const txt = (sel) => (d.querySelector(sel) || {}).textContent || '';

  check('a room event draws as an event line, not a message',
    d.querySelectorAll('.chat-event').length === 1
      && txt('.chat-event-who') === 'Marklifer',
    String(d.querySelectorAll('.chat-event').length));

  check('messages use the shared row class',
    d.querySelectorAll('.chat-msg').length === 3,
    String(d.querySelectorAll('.chat-msg').length));
  check('...and none of the old bespoke markup survives',
    d.querySelectorAll('.rv-chat-row, .rv-chat-who, .rv-chat-body-text').length === 0);

  // The things the rail simply did not have before.
  check('every message carries a clock',
    [...d.querySelectorAll('.chat-msg:not(.chat-mod-oneline)')]
      .every((n) => /^\d\d:\d\d$/.test((n.querySelector('.chat-msg-time') || {}).textContent || '')),
    [...d.querySelectorAll('.chat-msg-time')].map((n) => n.textContent).join(' '));
  check('the sender tag is a tag, not glued to the name',
    txt('.chat-msg-tag') === '[SN.C]', txt('.chat-msg-tag'));
  check('a run from one sender collapses its header',
    d.querySelectorAll('.chat-msg.chat-mod-cont').length === 1,
    String(d.querySelectorAll('.chat-msg.chat-mod-cont').length));
  check('an emote is one line, not a header plus a body',
    d.querySelectorAll('.chat-msg.chat-mod-oneline').length === 1
      && /watches/.test(txt('.chat-mod-emote')),
    txt('.chat-mod-emote'));

  /* A rail is the same row with LESS on it, not a different one.
   *
   * React, reply, pin, edit and delete belong to a full timeline. If they ever
   * appeared here it would mean the rail had been handed the Comms window's
   * `controls` hook by accident.
   */
  check('no timeline controls are bolted onto the rail',
    d.querySelectorAll('.chat-react-btn, .chat-reply-btn, .chat-pin-btn, .chat-edit-btn').length === 0);

  // The component's CSS has to reach this document, or the rows render as
  // unstyled divs — the class-toggle-with-no-rule failure, one level up.
  const sheets = [...d.querySelectorAll('link[rel=stylesheet]')].map((l) => l.getAttribute('href'));
  check('the row stylesheet is linked here too',
    sheets.includes('css/chat-rows.css'), sheets.join(', '));
}

console.log(failures ? failures + ' failure(s)' : 'all checks passed');
w.close();
process.exit(failures ? 1 : 0);
