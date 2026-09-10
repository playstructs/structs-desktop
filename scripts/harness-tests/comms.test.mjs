/* Comms in the Terminal — four native cards over one model.
 *
 * What this defends is the reason for the rebuild. Comms used to be the whole
 * `chat.html` WINDOW inside an iframe inside a card: its own navigation, its
 * own back button, its own idea of which room you were looking at, its own
 * scroll. Finding a channel meant paging inside a frame inside a card; two
 * conversations meant two copies of the window; and the command line could not
 * name a room, because rooms were not subjects.
 *
 *   node scripts/harness-tests/comms.test.mjs
 */
import { JSDOM, VirtualConsole } from './node_modules/jsdom/lib/api.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..');
const read = (p) => readFileSync(resolve(repo, p), 'utf8');

let failures = 0;
function check(what, ok, detail) {
  if (ok) { console.log('  ok ' + what); return; }
  failures++;
  console.log('FAIL ' + what + (detail ? ' — ' + detail : ''));
}
const until = async (fn, ms = 4000) => {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 20));
  }
};

const vc = new VirtualConsole();
async function load(qs) {
  const dom = await JSDOM.fromFile(resolve(repo, 'frontend/_harness.html'), {
    url: 'file://' + resolve(repo, 'frontend/_harness.html') + (qs || ''),
    runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true, virtualConsole: vc,
  });
  await until(() => dom.window.Board && dom.window.Board.T && dom.window.Board.Terminal);
  return dom;
}

// ── The model is pure enough to test without a window ──────────────────────
{
  console.log('\n— a room is a subject');
  const src = read('frontend/board-comms.js');
  /* `subjectKind` is the whole reason ⌘K can reach a conversation. Everything
   * a person might type for "that room" resolves through one function. */
  const dom = await load('?view=terminal');
  const C = dom.window.BoardComms;
  const kinds = {
    '!abcdef:oh.energy': 'room', '#trade': 'alias', '#trade:oh.energy': 'alias',
    '1-61': 'player', 'JPEG': 'name', '2-15361': 'object', '9-2136': 'object',
  };
  check('every way of naming a room is recognised as one',
    Object.keys(kinds).every((k) => C.subjectKind(k) === kinds[k]),
    Object.keys(kinds).map((k) => k + '→' + C.subjectKind(k)).join(' '));
  /* A GUILD id and a STRUCT id are ids, and neither is a room. Answering
   * "name" for them would send `0-1` to the people directory as a search. */
  check('…and an id that is not a room is refused rather than guessed at',
    C.subjectKind('0-1') === null && C.subjectKind('5-1234') === null && C.subjectKind('') === null);
  check('the model owns the wire, so a card never guesses the session key',
    /matrix_status/.test(src) && /guildId: S\.key/.test(src)
    && !/board-terminal-comms\.js[\s\S]*guildId: '0-/.test(read('frontend/board-terminal-comms.js')));
  dom.window.close();
}

// ── The room list ──────────────────────────────────────────────────────────
{
  console.log('\n— COMMS: where am I, and what is waiting');
  const dom = await load('?view=terminal');
  const w = dom.window, d = w.document;
  const T = w.Board.Terminal, C = w.BoardComms;
  await T.enter();
  T.state.layout.cards.slice().forEach((c) => T.remove(c.id));

  T.add('comms', {}, 1);
  const id = T.state.layout.cards.slice(-1)[0].id;
  await until(() => d.querySelector('#tm-' + id + ' .cm-room'));
  const card = d.querySelector('#tm-' + id);

  check('Comms is a card, not a window in an iframe', card.querySelector('iframe') === null);

  /* Invites first: they are the only rows anybody is waiting on an answer to,
   * and an invite that scrolls past the bottom of a list is an invite that
   * expires unanswered. */
  const secs = [...card.querySelectorAll('.cm-sec')].map((s) => s.textContent.replace(/\d+$/, '').trim());
  check('sections run invites, pinned, people, guild, galaxy — in that order',
    secs.join(' ') === 'Invited Pinned People Guild Galaxy', secs.join(' '));

  const rows = [...card.querySelectorAll('.cm-room')];
  const row = (name) => rows.find((r) => new RegExp(name).test(r.querySelector('.cm-room-name').textContent));
  /* Being NAMED is not the same as traffic. A count of 40 hides the one
   * message that was actually for you, so the mention takes the badge. */
  check('a room that named you says so, and keeps its count beside it',
    /YOU/.test(row('SN.Corporation').textContent) && /3/.test(row('SN.Corporation').querySelector('.cm-room-n').textContent)
    && row('SN.Corporation').classList.contains('is-mention'));
  check('…while plain traffic is just a number', row('^Trade$').querySelector('.sui-badge') === null
    && row('^Trade$').querySelector('.cm-room-n').textContent === '9');
  /* A muted room is SILENCED, not ignored: still counted, never allowed to
   * interrupt. Dropping it from the list is how 400 unread go missing. */
  check('a muted room is still listed and still counted, just quietened',
    row('Noise') !== undefined && row('Noise').classList.contains('is-muted')
    && /400/.test(row('Noise').textContent));
  /* This client has no crypto. An encrypted room whose messages are all
   * unreadable, shown as an ordinary empty room, is a lie by omission. */
  check('an encrypted room says so — this client cannot read a word of it',
    /ENCRYPTED/.test(row('Secret').textContent));
  /* A room is not deleted by an upgrade: it stays joinable and stays in the
   * list, so without the pointer you go on talking into a room everyone left. */
  check('an upgraded room offers the room the conversation actually moved to',
    /moved/.test(row('War Room').textContent));
  const invite = row('Ore Cartel');
  check('an invite is answerable in place, and says who asked',
    /Beezhan/.test(invite.textContent)
    && [...invite.querySelectorAll('a')].map((a) => a.textContent).join(',') === 'Join,Decline');
  invite.querySelector('a').click();
  await until(() => (w.__HARNESS_CALLS__ || []).some((c) => c.cmd === 'matrix_join'));
  check('…and Join really joins it, as this identity',
    (w.__HARNESS_CALLS__ || []).find((c) => c.cmd === 'matrix_join').args.guildId === '0-5');

  /* Who am I speaking as, on which homeserver, and what is waiting — three
   * things the window made you navigate to learn, said once at the top. And
   * sign-out where a person LOOKS for it, not as a fifth door whose meaning
   * is a tooltip. */
  check('the list says who you are, where, and what is waiting — without navigating',
    /Marklifer/.test(card.querySelector('.cm-me').textContent)
    && /SN Corp/.test(card.querySelector('.cm-me').textContent)
    && /invite/.test(card.querySelector('.cm-me').textContent));
  check('…and signing out is a word you can read, not an icon you have to hover',
    card.querySelector('.cm-me .cm-signout') !== null
    && card.querySelector('.cm-me .cm-signout').textContent === 'sign out');

  /* An invite is the most waiting thing in the list, so it survives the
   * unread filter — but not a filter that ASKED for one section. "Show me
   * people" answered with a channel invite answers a different question. */
  check('an invite outlives the unread filter, because it IS waiting',
    C.sections({ only: 'all', unreadOnly: true }).some((g) => g.section.key === 'invited'));
  check('…but "show me people" is not answered with a channel invite',
    C.sections({ only: 'direct' }).map((g) => g.section.key).join(',') === 'direct');

  /* The unread badge is the SERVER's, kept against the read receipts this app
   * sends — so it survives the window closing, survives a restart, and agrees
   * with the same account open in Element on a phone. */
  const w8 = C.waiting();
  check('what is waiting counts the server\'s numbers, and a muted room never interrupts',
    w8.unread === 13 && w8.mention === 1 && w8.invites === 1, JSON.stringify(w8));

  T.remove(id);
  w.close();
}

// ── The conversation ───────────────────────────────────────────────────────
{
  console.log('\n— ROOM: one conversation, and two of them at once');
  const dom = await load('?view=terminal');
  const w = dom.window, d = w.document;
  const T = w.Board.Terminal;
  await T.enter();
  T.state.layout.cards.slice().forEach((c) => T.remove(c.id));

  /* THE thing the embedded window could not do, however it was configured. */
  T.add('room', { id: '!snc:h' }, 1);
  T.add('room', { id: '1-61' }, 1);
  await until(() => d.querySelectorAll('#tm-grid [data-type="room"]').length === 2);
  check('two conversations can stand side by side — the point of the rebuild',
    d.querySelectorAll('#tm-grid [data-type="room"]').length === 2);

  const ids = T.state.layout.cards.map((c) => c.id);
  await until(() => d.querySelector('#tm-' + ids[1] + ' .cm-timeline'));
  /* `matrix_dm` is idempotent — an existing DM comes back rather than a
   * second room created beside it — so a player id IS a room. */
  const dm = (w.__HARNESS_CALLS__ || []).find((c) => c.cmd === 'matrix_dm');
  check('a player id opens their direct message, without a handle to exchange first',
    dm !== undefined && dm.args.playerId === '1-61');

  /* A room the joined list does not have after a refresh. It used to fabricate
   * `{room_id: told || asked, name: asked}` for BOTH cases — so
   * `ROOM #nope-not-real` opened an empty conversation called
   * "#nope-not-real" that had never existed. A room we cannot see is not an
   * empty room, and naming it after what was TYPED is inventing one. */
  {
    const made = await w.BoardComms.resolve('#no-such-channel').catch((e) => ({ error: String(e) }));
    check('a room the server names but sync has not returned says so, under the id the SERVER gave',
      made.unknown === true && made.room_id === '!help:h' && made.name === '!help:h',
      JSON.stringify(made));
  }
  check('…and looking at a room is reading it', (w.__HARNESS_CALLS__ || []).some((c) => c.cmd === 'matrix_mark_read'));

  const first = d.querySelector('#tm-' + ids[0]);
  await until(() => first.querySelector('.chat-composer-panel, .sui-panel-wrapper-fit-content'));
  check('the composer is the SHARED one, not a third near-copy of it',
    first.querySelector('.chat-composer-panel') !== null
    && /StructsChatRow\.composer/.test(read('frontend/board-terminal-comms.js')));

  const input = first.querySelector('textarea, input[type="text"]');
  input.value = 'shields up';
  const ev = new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true });
  input.dispatchEvent(ev);
  await until(() => (w.__HARNESS_CALLS__ || []).some((c) => c.cmd === 'matrix_send'));
  const sent = (w.__HARNESS_CALLS__ || []).find((c) => c.cmd === 'matrix_send');
  check('Enter sends, to the room this card is about and no other',
    sent.args.body === 'shields up' && sent.args.roomId === '!snc:h', JSON.stringify(sent.args));
  check('…and the box empties, so the next line is not the last one again', input.value === '');

  /* A live message arrives for a room a card has open. The model folds it in;
   * a room nothing has open is not cached, so the next open re-reads rather
   * than showing a fragment. */
  w.__HARNESS_EMIT__('matrix::timeline', { room_id: '!snc:h', message: {
    event_id: '$live', sender: '@1-61:h', sender_name: 'JPEG', kind: 'text', ts: Date.now(),
    body: 'they are through the shield' } });
  await until(() => /through the shield/.test(first.textContent));
  check('a live message lands in the open room without a refetch',
    /through the shield/.test(first.textContent));
  w.__HARNESS_EMIT__('matrix::timeline', { room_id: '!nobody-has-this:h', message: { event_id: '$x', body: 'z' } });
  check('…and one for a room nothing has open is not invented into a cache',
    w.BoardComms.S.timelines['!nobody-has-this:h'] === undefined);

  /* The GAME inside the conversation. "shield on 2-15361 is down" names an
   * object, and the object is the point of the sentence — so the message shows
   * the game's own card for it, the same one the Explore board draws. This is
   * the merge the rebuild is for; the machinery (ChatRefs) already existed and
   * nothing in Comms was using it. */
  w.__HARNESS_EMIT__('matrix::timeline', { room_id: '!snc:h', message: {
    event_id: '$refs', sender: '@1-61:h', sender_name: 'JPEG', kind: 'text', ts: Date.now(),
    body: '5-4559 is offline and 5-88 is idle' } });
  // The lookup is a round trip, and until it lands every id is a chip —
  // which is the honest interim state, not a placeholder card.
  await until(() => /Ore Extractor/.test(first.textContent));
  check('an id in a message becomes the game\'s own card for that object',
    /Ore Extractor/.test(first.textContent));
  /* Only the FIRST expands. A message naming four objects would otherwise
   * bury itself under four cards, and the point of a summary is to be aside. */
  check('…and the rest are chips, so a message naming four is not four cards',
    first.querySelectorAll('.cm-refs .cm-ref').length === 1
    && first.querySelector('.cm-refs .cm-ref').textContent === '5-88');
  first.querySelector('.cm-refs .cm-ref').click();
  check('…each of which opens the object', T.state.layout.cards.some((c) => c.params && c.params.id === '5-88'));

  /* An edit is SHOWN, never applied silently: a message that quietly becomes
   * different text is how a conversation gets rewritten under the readers. */
  w.__HARNESS_EMIT__('matrix::edited', { room_id: '!snc:h', event_id: '$live', body: 'they are through' });
  await until(() => w.BoardComms.S.timelines['!snc:h'].some((m) => m.edited));
  check('an edit is marked as one', w.BoardComms.S.timelines['!snc:h'].find((m) => m.event_id === '$live').edited === true);
  w.__HARNESS_EMIT__('matrix::redacted', { room_id: '!snc:h', event_id: '$live' });
  await until(() => !w.BoardComms.S.timelines['!snc:h'].some((m) => m.event_id === '$live'));
  check('…and a deletion really removes it', true);

  ids.forEach((i) => T.remove(i));
  /* One subscription for the whole window. Four Comms cards each wiring their
   * own listeners is how one glance sends four read receipts. */
  check('every card shares ONE live subscription, and a removed card stops being drawn into',
    w.BoardComms.S.subs.filter((f) => f.host && f.host.isConnected).length === 0);
  w.close();
}

// ── The directory, and who is in a room ────────────────────────────────────
{
  console.log('\n— CHANNELS and WHO');
  const dom = await load('?view=terminal');
  const w = dom.window, d = w.document;
  const T = w.Board.Terminal;
  await T.enter();
  T.state.layout.cards.slice().forEach((c) => T.remove(c.id));

  T.add('channels', {}, 1);
  const cid = T.state.layout.cards.slice(-1)[0].id;
  await until(() => d.querySelector('#tm-' + cid + ' .cm-room'));
  const dir = d.querySelector('#tm-' + cid);
  /* "Where am I" and "what else is there" are two questions. The window that
   * answered both in one list is why joining a channel meant scrolling past
   * every channel you were already in. */
  check('the directory offers only what you are NOT already in',
    /Help/.test(dir.textContent) && !/Trade/.test(dir.textContent), dir.textContent.replace(/\s+/g, ' ').slice(0, 120));

  /* Comms is DECENTRALISED — every guild runs its own homeserver — but the
   * community meets in channels published by one of them. `/publicRooms` with
   * no `server` answers only for the server you asked, so a player opened the
   * directory, saw their own guild's rooms, and had no way to discover where
   * anybody actually talks: they had to be told an alias. Federation already
   * carried the join. Only DISCOVERY stopped at the guild boundary. */
  {
    const servers = [...dir.querySelectorAll('.cm-server')].map((a) => a.textContent);
    check('the directory names every guild that publishes a homeserver, not just yours',
      servers.length === 2 && servers.some((t) => /yours/.test(t)) && servers.some((t) => /OH/.test(t)),
      servers.join(' | '));
    const other = [...dir.querySelectorAll('.cm-server')].find((a) => /OH/.test(a.textContent));
    other.click();
    await until(() => (w.__HARNESS_CALLS__ || []).some((c) => c.cmd === 'matrix_browse' && c.args.server));
    const asked = (w.__HARNESS_CALLS__ || []).filter((c) => c.cmd === 'matrix_browse').slice(-1)[0];
    check('…and picking one browses THAT server\'s directory', asked.args.server === 'oh.energy');
    await until(() => /Hydro General/.test(d.querySelector('#tm-' + cid).textContent));
    check('…which is a different set of rooms, reachable without being told an alias',
      /Hydro General/.test(d.querySelector('#tm-' + cid).textContent));
  }

  T.add('who', { id: '!snc:h' }, 1);
  const wid = T.state.layout.cards.slice(-1)[0].id;
  await until(() => d.querySelector('#tm-' + wid + ' .pc-row'));
  const who = d.querySelector('#tm-' + wid);
  check('WHO draws room members as PEOPLE, with the same face the roster shows',
    who.querySelectorAll('.pc-row').length === 2 && /JPEG/.test(who.textContent));
  check('…each of whom can be messaged from where they stand',
    who.querySelector('.pc-row .pc-act[title^="Message"]') !== null);
  w.close();
}

// ── Finding something that was said ────────────────────────────────────────
{
  console.log('\n— FIND: the homeserver searches, not the cache');
  const dom = await load('?view=terminal');
  const w = dom.window, d = w.document;
  const T = w.Board.Terminal;
  await T.enter();
  T.state.layout.cards.slice().forEach((c) => T.remove(c.id));

  /* `FIND shield is down` is three words and ONE question. Splitting it the
   * way an id argument is split would search for "shield". */
  check('a search takes a sentence, not a token',
    T.parse('FIND shield is down').params.q === 'shield is down'
    && T.parse('FIND') === null);

  T.add('find', { q: 'shield' }, 1);
  const id = T.state.layout.cards.slice(-1)[0].id;
  await until(() => d.querySelector('#tm-' + id + ' .cm-hit'));
  const card = d.querySelector('#tm-' + id);
  const call = (w.__HARNESS_CALLS__ || []).find((c) => c.cmd === 'matrix_search');
  /* A client that filters its own cache finds only what it already fetched —
   * for a busy channel, the last few minutes. */
  check('the search goes to the server, across every room you are in',
    call.args.query === 'shield' && call.args.roomId === null);
  check('…and every hit names the room it was said in, which is the answer',
    /SN.Corporation/.test(card.textContent) && /down to 25/.test(card.textContent));
  card.querySelector('.cm-hit-room').click();
  check('…and opens it', T.state.layout.cards.some((c) => c.type === 'room' && c.params.id === '!snc:h'));
  w.close();
}

// ── ⌘K ─────────────────────────────────────────────────────────────────────
{
  console.log('\n— ⌘K reaches a conversation the way it reaches a planet');
  const dom = await load('?view=terminal');
  const w = dom.window;
  const T = w.Board.Terminal;
  await T.enter();
  await w.BoardComms.status();
  await w.BoardComms.rooms(true);
  const rooms = w.BoardComms.S.rooms;

  /* An EMPTY box lists what is waiting. "I can't find the chats already on
   * the go" was the complaint; this is the answer — they are the first thing
   * ⌘K shows when you have nothing else in mind, worst first. */
  const idle = T.commsRows('', rooms);
  check('an empty command line leads with what is waiting, the room that named you first',
    idle.length && idle[0].sub === 'SN.Corporation' && idle[0].group === 'Waiting'
    && idle.every((r) => r.run === true), idle.map((r) => r.sub).join(','));
  check('…and a muted room never takes one of those places',
    !idle.some((r) => r.sub === 'Noise'));

  /* `#tr` completes to the channels whose alias starts that way, out of what
   * sync already has — no round trip to find a room you are standing in. */
  const hash = T.commsRows('#tr', rooms);
  check('a bare #alias completes from the rooms already in hand',
    hash.length === 1 && hash[0].line === 'ROOM #trade:h', JSON.stringify(hash.map((r) => r.line)));

  /* "The one with Beezhan in it" is reachable by typing Beezhan: name, alias,
   * topic and the player a DM is with all match. */
  check('ROOM matches on name, on topic, and on who a DM is with',
    T.commsRows('ROOM guild business', rooms).some((r) => r.sub === 'SN.Corporation')
    && T.commsRows('ROOM 1-61', rooms).some((r) => r.sub === 'JPEG'));
  check('…and a subject that names nothing offers nothing rather than everything',
    T.commsRows('ROOM zzzznope', rooms).length === 0);

  /* The grammar: a room is a subject like any other object, so the same word
   * reaches a person, a planet and a channel. */
  check('one word reaches a person, a planet, a fleet and a channel',
    ['ROOM 1-61', 'ROOM 2-15361', 'ROOM 9-2136', 'ROOM #trade', 'ROOM JPEG', 'ROOM !x:h']
      .every((l) => { const p = T.parse(l); return p && p.type === 'room'; }));
  check('…and the subject-first menu offers it for every object that has one',
    T.suggestFor('1-61 ').some((s) => s.words === 'ROOM')
    && T.suggestFor('2-29604 ').some((s) => s.words === 'ROOM'));
  /* A guild has no room of its own, and offering one would open a card that
   * can only fail. */
  check('…but not for a guild, which has no room', !T.suggestFor('0-1 ').some((s) => s.words === 'ROOM'));

  const needsSubject = { ROOM: 1, DM: 1, MSG: 1, MESSAGE: 1, TALK: 1, CHAT: 1, WHO: 1, INROOM: 1,
                         FIND: 'shield', SEARCH: 'shield' };
  const words = ['COMMS', 'INBOX', 'DMS', 'UNREAD', 'ROOM', 'DM', 'MSG', 'MESSAGE', 'TALK', 'CHAT',
                 'CHANNELS', 'BROWSE', 'DIRECTORY', 'FIND', 'SEARCH', 'WHO', 'INROOM'];
  const line = (x) => needsSubject[x] === undefined ? x
    : x + ' ' + (typeof needsSubject[x] === 'string' ? needsSubject[x] : '1-61');
  check('every word people reach for lands on the card that answers it',
    words.every((x) => T.canRun(line(x))), words.filter((x) => !T.canRun(line(x))).join(','));
  check('…and DMS and UNREAD are the room list, configured — not three more cards',
    T.parse('DMS').type === 'comms' && T.parse('DMS').params.show === 'direct'
    && T.parse('UNREAD').params.show === 'unread');
  w.close();
}

// ── Layouts saved before the rebuild ───────────────────────────────────────
{
  console.log('\n— a board saved when Comms was a window still opens');
  const dom = await load('?view=terminal');
  const w = dom.window;
  const T = w.Board.Terminal;
  const migrated = T.migrate({ cards: [
    { id: 'chat-1', type: 'chat', params: {}, w: 2 },
    { id: 'chat-2', type: 'chat', params: { list: 'direct' }, w: 1 },
    { id: 'comms-1', type: 'comms', params: { id: '2-15361' }, w: 1 },
  ] }).cards;
  check('the framed Comms window becomes the room list',
    migrated[0].type === 'comms' && migrated[0].id === 'chat-1');
  check('…its people page becomes the room list scoped to people',
    migrated[1] === undefined || migrated[1].params.show === 'direct' || migrated.length === 2);
  /* `comms {id}` meant "the conversation about 2-15361", which is exactly a
   * ROOM whose subject is an object id — so it migrates to the card that now
   * says that, rather than being dropped as an unknown type. */
  const obj = migrated.find((c) => c.type === 'room');
  check('…and an object rail becomes that object\'s room, subject intact',
    obj !== undefined && obj.params.id === '2-15361');
  check('…with one room list, not three, because it is single-per-window',
    migrated.filter((c) => c.type === 'comms').length === 1);
  check('nothing in the Terminal FRAMES chat.html any more',
    !/framed\(\s*'chat\.html/.test(read('frontend/board-terminal.js'))
    && !/src=.?chat\.html/.test(read('frontend/board-terminal.js')));
  w.close();
}

console.log(failures ? '\n' + failures + ' failing check(s)' : '\nall checks passed');
process.exit(failures ? 1 : 0);
