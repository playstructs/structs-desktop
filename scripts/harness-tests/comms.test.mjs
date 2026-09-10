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

// ── The wire, checked against Rust itself ──────────────────────────────────
//
// THE bug class that broke this migration. Every Comms card was written against
// what I ASSUMED the commands took, and the harness fixture answers any shape,
// so all of it tested green while none of it worked:
//
//   matrix_mark_read  needs event_id  — sent without one, so NO read receipt
//                     ever reached the server and unread counts never cleared
//   matrix_send       reply_to is a STRUCT {event_id, sender, body} — sent a
//                     bare string, so replying failed outright
//   matrix_react      needs `on` — omitted, so reactions did nothing and there
//                     was no way to take one back
//
// So the shapes are derived FROM `src-tauri/src/matrix/mod.rs` and compared to
// what the frontend really sends. A signature that changes, or a call written
// from memory, fails here instead of in somebody's conversation.
{
  console.log('\n— every call matches the command it is calling');
  const rust = read('src-tauri/src/matrix/mod.rs');
  const sig = {};
  for (const m of rust.matchAll(/pub (?:async )?fn (matrix_\w+)\(([^)]*)\)/g)) {
    sig[m[1]] = m[2].split(',').map((a) => a.trim().split(':')[0].trim())
      .filter((a) => a && a !== 'app');
  }
  const snake = (k) => k.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());
  const js = [];
  for (const f of ['frontend/board-comms.js', 'frontend/board-terminal-comms.js']) {
    const src = read(f);
    for (const m of src.matchAll(/invoke\('(matrix_\w+)',\s*\{([^}]*)\}/g)) {
      js.push({ cmd: m[1], keys: [...m[2].matchAll(/(\w+)\s*:/g)].map((k) => snake(k[1])), file: f });
    }
  }
  check('every matrix command the cards call actually exists',
    js.every((c) => sig[c.cmd]), js.filter((c) => !sig[c.cmd]).map((c) => c.cmd).join(','));

  /* A key Rust does not take is silently dropped by serde; a key it REQUIRES
   * and does not get is a deserialisation failure — the whole call. Only
   * `Option<_>` parameters may be omitted. */
  const optional = {};
  for (const m of rust.matchAll(/pub (?:async )?fn (matrix_\w+)\(([^)]*)\)/g)) {
    optional[m[1]] = new Set(
      m[2].split(',').filter((a) => /:\s*Option</.test(a))
        .map((a) => a.trim().split(':')[0].trim()));
  }
  const missing = js.flatMap((c) => (sig[c.cmd] || [])
    .filter((p) => !optional[c.cmd].has(p) && !c.keys.includes(p))
    .map((p) => c.cmd + ' needs ' + p));
  check('…and passes every argument that is not optional',
    missing.length === 0, [...new Set(missing)].join(' · '));

  const unknown = js.flatMap((c) => c.keys.filter((k) => !(sig[c.cmd] || []).includes(k))
    .map((k) => c.cmd + ' has no ' + k));
  check('…and invents none that the command does not take',
    unknown.length === 0, [...new Set(unknown)].join(' · '));

  /* The OTHER half, and the half that produced the typing and presence bugs.
   *
   * Rust pushes `matrix::typing` with `names` and the model read `user_ids`;
   * `matrix::presence` with a `presence` MAP and the model read `p.user_id`.
   * Both fail silently — a handler that reads a key nobody sent gets undefined
   * and carries on, so the indicator simply never appears and nothing anywhere
   * says why. Derived from the emit sites the same way the calls are. */
  const emits = {};
  const opaque = new Set();
  for (const f of ['src-tauri/src/matrix/mod.rs', 'src-tauri/src/matrix/client.rs']) {
    const rs = read(f);
    // Every event name that is emitted at all, however its payload is built.
    for (const m of rs.matchAll(/"(matrix::\w+)"/g)) emits[m[1]] = emits[m[1]] || new Set();
    // The ones whose payload is a literal right there.
    for (const m of rs.matchAll(/"(matrix::\w+)",\s*\n?\s*json!\(\{([\s\S]{0,400}?)\}\)/g)) {
      for (const k of m[2].matchAll(/"(\w+)"\s*:/g)) emits[m[1]].add(k[1]);
    }
    /* And the ones whose payload is built into a variable first — `let payload
     * = …; emit(…, p)` — or handed a whole function's return, like
     * `status_payload_as()`. Their keys cannot be read from the emit site, so
     * the KEY check is skipped for them rather than guessed at: a check that
     * invents an answer is worse than one that admits it does not know. */
    for (const m of rs.matchAll(/"(matrix::\w+)",\s*\n?\s*(?!json!\(\{)[a-z_]/g)) opaque.add(m[1]);
  }
  /* Handlers by BRACE-MATCHING, not by regex. A non-greedy match to the block
   * close ran a one-line handler on into the next one and blamed its keys on
   * the wrong event — `matrix::edited has no count`, when `count` was read by
   * the `matrix::unread` handler beneath it. */
  const comms = read('frontend/board-comms.js');
  const handlers = [];
  for (const m of comms.matchAll(/on\('(matrix::\w+)',\s*function\s*\(p\)\s*\{/g)) {
    let i = m.index + m[0].length, depth = 1;
    while (i < comms.length && depth) { if (comms[i] === '{') depth++; else if (comms[i] === '}') depth--; i++; }
    const body = comms.slice(m.index + m[0].length, i - 1);
    handlers.push({ ev: m[1], keys: [...new Set([...body.matchAll(/\bp\.(\w+)/g)].map((k) => k[1]))] });
  }
  check('the model listens for events Rust really emits',
    handlers.every((h) => emits[h.ev]),
    handlers.filter((h) => !emits[h.ev]).map((h) => h.ev).join(','));

  /* A payload whose keys the emitter never sends. `guild_id`, `room_id` and
   * `event_id` are on almost every emit and are allowed anywhere; anything
   * else has to be a key that event really carries. */
  const everywhere = new Set(['guild_id', 'room_id', 'event_id']);
  const phantom = handlers.flatMap((h) => (h.keys || [])
    .filter((k) => !everywhere.has(k) && !opaque.has(h.ev) && emits[h.ev] && !emits[h.ev].has(k))
    .map((k) => h.ev + ' has no ' + k));
  check('…and reads only keys those events really carry',
    phantom.length === 0, [...new Set(phantom)].join(' · '));
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

  /* PINNED · WAITING · QUIET, not one group per Matrix concept.
   *
   * The five fixed sections mirrored the model and answered the wrong
   * question: the Guild/Galaxy split was by YOUR homeserver, so in a community
   * whose centre of gravity is another guild's server every channel anybody
   * talks in filed under "Galaxy" beside random rooms — and sections that are
   * usually empty cost a 306px column every day. */
  const secs = [...card.querySelectorAll('.cm-sec')].map((s) => s.textContent.replace(/[\u25b8\s\d]+$/, '').trim());
  check('the list groups by what is WAITING, with what you pinned held stable above it',
    secs.join(' ') === 'Invited Pinned Unread Everything else', secs.join(' '));
  /* The guild's own pinned channels are pinned for EVERYONE — joined or not.
   * Filtering out every unjoined room filtered out exactly those, and the
   * question "where did the three pinned channels go" had no answer. */
  w.__HARNESS_EMIT__('matrix::rooms', { guild_id: '0-5', rooms: C.S.rooms.concat([
    { room_id: '!rules:h', name: 'Rules', canonical_alias: '#rules:h', section: 'local', joined: false,
      home_rank: 1, members: 900, unread: 0, mention: false, icon: 'icon-beacon' },
  ]) });
  await until(() => [...card.querySelectorAll('.cm-room')].some((r) => /Rules/.test(r.textContent)));
  const rules = [...card.querySelectorAll('.cm-room')].find((r) => /Rules/.test(r.textContent));
  check('a pinned channel you have not joined is still in Pinned, with a Join in the row',
    C.sectionOf(C.roomById('!rules:h')) === 'pinned' && rules.querySelector('.cm-room-act') !== null
    && /Join/.test(rules.querySelector('.cm-room-act').textContent) && !/Decline/.test(rules.textContent));
  check('…and a plain unjoined room is not', !/Alpha Base/.test(card.textContent));
  /* The quiet ones are most of the list and none of the answer — collapsed to
   * a count, never hidden, because a room you cannot find is a room you have
   * left without deciding to. */
  const quiet = [...card.querySelectorAll('.cm-sec')].find((n) => /Everything else/.test(n.textContent));
  check('…and the quiet ones fold to a count you can open',
    /▸/.test(quiet.textContent) && quiet.classList.contains('is-foldable'));
  quiet.click();
  await until(() => !/▸/.test([...card.querySelectorAll('.cm-sec')].find((n) => /Everything else/.test(n.textContent)).textContent));
  check('…opening it shows them', true);

  const row = (name) => [...card.querySelectorAll('.cm-room')]
    .find((r) => new RegExp(name).test(r.querySelector('.cm-room-name').textContent));
  /* Being NAMED is not the same as traffic. A count of 40 hides the one
   * message that was actually for you, so the mention takes the badge. */
  check('a room that named you says so, and keeps its count beside it',
    /YOU/.test(row('SN.Corporation').textContent) && /3/.test(row('SN.Corporation').querySelector('.cm-room-n').textContent)
    && row('SN.Corporation').classList.contains('is-mention'));
  check('…while plain traffic is just a number', row('^Trade$').querySelector('.sui-badge') === null
    && row('^Trade$').querySelector('.cm-room-n').textContent === '9');
  /* A muted room is SILENCED, not ignored: still counted, never allowed to
   * interrupt — so it files under QUIET however loud it is, and is still
   * there with its number on it. Dropping it is how 400 unread go missing. */
  check('a muted room is quiet, not gone — still listed, still counted',
    row('Noise') !== undefined && row('Noise').classList.contains('is-muted')
    && /400/.test(row('Noise').textContent)
    && C.sectionOf(C.roomById('!noise:h')) === 'quiet');
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
  /* An invite is the most waiting thing there is, so it survives the unread
   * filter — but not a filter that asked for one PLACE. */
  check('…but "show me people" is not answered with a channel invite',
    !C.sections({ only: 'direct' }).some((g) => g.section.key === 'invited'));

  /* WHERE a room is, derived rather than configured.
   *
   * Comms is decentralised — every guild runs a homeserver — but a community
   * has a centre of gravity, and when that centre is another guild's server
   * the old Guild/Galaxy split filed every channel anybody actually talks in
   * under "Galaxy" beside genuinely random rooms. The Hub is the server the
   * largest share of your joined channels live on when it is not your own, so
   * a community that moves takes the label with it and nobody types anything.
   */
  check('one stray federated room is not a community hub',
    C.hubServer() === null || typeof C.hubServer() === 'string');
  check('a room says which server it is on when that is not your own',
    ['hub', 'guild', 'galaxy', 'direct'].includes(C.placeOf(C.roomById('!trade:h'))));

  /* Pinning is what makes the top of the list STABLE. You look for #trade by
   * position, and a list that re-sorts every time somebody speaks is a list
   * you cannot learn. */
  {
    const pinnable = row('^Trade$').querySelector('.cm-room-pin');
    check('any room can be pinned to the top', pinnable !== null);
    pinnable.click();
    await until(() => C.isPinned('!trade:h'));
    check('…and a pinned room moves into the stable group',
      C.sectionOf(C.roomById('!trade:h')) === 'pinned');
    C.togglePin('!trade:h');
  }

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
    /* `matrix_join` names no room — it answers `{ ok: true }` — so a join
     * that sync has not returned yet is keyed by the alias we ASKED for,
     * marked unknown. That key is what lets the card find the real room when
     * the sync lands, because the list matches on canonical alias. What it
     * must never do is invent a DIFFERENT room than the one asked for. */
    const made = await w.BoardComms.resolve('#no-such-channel').catch((e) => ({ error: String(e) }));
    check('a join sync has not returned yet is a room in a known state, keyed by what was asked for',
      made.unknown === true && made.room_id === '#no-such-channel' && !made.error,
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
  w.__HARNESS_EMIT__('matrix::timeline', { room_id: '!snc:h', messages: [{
    event_id: '$live', sender: '@1-61:h', sender_name: 'JPEG', kind: 'text', ts: Date.now(),
    body: 'they are through the shield' }] });
  await until(() => /through the shield/.test(first.textContent));
  check('a live message lands in the open room without a refetch',
    /through the shield/.test(first.textContent));
  w.__HARNESS_EMIT__('matrix::timeline', { room_id: '!nobody-has-this:h', messages: [{ event_id: '$x', body: 'z' }] });
  check('…and one for a room nothing has open is not invented into a cache',
    w.BoardComms.S.timelines['!nobody-has-this:h'] === undefined);

  /* The GAME inside the conversation — INLINE.
   *
   * This first expanded the first id a message named into the game's own full
   * card, underneath it. Right on a board, wrong in a chat: a channel where
   * every third line names a planet became a column of cards with conversation
   * wedged between them, and the thing you were reading was the smallest
   * element on screen. The id stays in the SENTENCE now, as a chip. */
  w.__HARNESS_EMIT__('matrix::timeline', { room_id: '!snc:h', messages: [{
    event_id: '$refs', sender: '@1-61:h', sender_name: 'JPEG', kind: 'text', ts: Date.now(),
    body: 'shield on 2-15361 is down and 9-2136 is two jumps out' }] });
  await until(() => first.querySelector('[data-event="$refs"] .cm-id'));
  const line = first.querySelector('[data-event="$refs"]');
  const chips = [...line.querySelectorAll('.cm-id')].map((c) => c.textContent.trim());
  check('every id in a line is a LINK, in the line, and the line still reads as a sentence',
    chips.join(',') === '2-15361,9-2136'
    && /shield on .* is down and .* is two jumps out/.test(line.textContent), chips.join(','));
  // A link and nothing more — no icon, no chip dressing.
  check('…a plain link: no icon, no decoration of its own',
    [...line.querySelectorAll('.cm-id')].every((c) => c.tagName === 'A' && c.children.length === 0)
    && !/\.cm-id\s*\{/.test(read('frontend/chat-rows.css')));
  /* A chip opens a WINDOW, not a card pushed onto the board behind the
   * conversation you are in the middle of. */
  line.querySelector('.cm-id').click();
  await until(() => (w.__HARNESS_CALLS__ || []).some((c) => c.cmd === 'open_terminal_card_new'));
  const opened = (w.__HARNESS_CALLS__ || []).filter((c) => c.cmd === 'open_terminal_card_new').slice(-1)[0];
  check('…and opens the right kind of card, in its own window',
    opened.args.kind === 'planet' && opened.args.params.id === '2-15361', JSON.stringify(opened.args));

  /* Both sides bounded, or `5-260550` matches inside a longer run of digits
   * and a date reads as a fleet — the id-prefix trap, in a sentence. */
  {
    const box = d.createElement('div');
    box.appendChild(T.idChips('built 5-260550 on 2026-09-09 at v1-2 for 1-61'));
    const got = [...box.querySelectorAll('.cm-id')].map((c) => c.textContent.trim());
    check('a date is not a fleet and a version is not a player',
      got.join(',') === '5-260550,1-61', got.join(','));
  }

  /* Typing and presence, in the shapes Rust really pushes.
   *
   * `matrix::typing` carries `names` — already resolved, because the window has
   * no business turning `@1-61:h` into "JPEG" a second time. The model read
   * `user_ids`, which nothing has ever sent, so the typing line never appeared
   * once. `matrix::presence` carries the WHOLE map keyed by player; the model
   * read `p.user_id` off it and returned early every time. */
  w.__HARNESS_EMIT__('matrix::typing', { guild_id: '0-5', room_id: '!snc:h', names: ['JPEG'] });
  await until(() => /typing/.test(first.textContent));
  check('a typing indicator reads the names Rust sends, not ids it never sent',
    /typing/.test(first.textContent) && w.BoardComms.S.typing['!snc:h'].join() === 'JPEG');
  w.__HARNESS_EMIT__('matrix::presence', { guild_id: '0-5', presence: { '1-61': { state: 'online' } } });
  check('presence arrives as the whole map, keyed by player',
    w.BoardComms.S.presence['1-61'] && w.BoardComms.S.presence['1-61'].state === 'online',
    JSON.stringify(w.BoardComms.S.presence));

  /* An edit is SHOWN, never applied silently: a message that quietly becomes
   * different text is how a conversation gets rewritten under the readers. */
  w.__HARNESS_EMIT__('matrix::edited', { room_id: '!snc:h', event_id: '$live', body: 'they are through' });
  await until(() => w.BoardComms.S.timelines['!snc:h'].some((m) => m.edited));
  check('an edit is marked as one', w.BoardComms.S.timelines['!snc:h'].find((m) => m.event_id === '$live').edited === true);
  w.__HARNESS_EMIT__('matrix::redacted', { room_id: '!snc:h', event_id: '$live' });
  await until(() => !w.BoardComms.S.timelines['!snc:h'].some((m) => m.event_id === '$live'));
  check('…and a deletion really removes it', true);

  // ── Select-then-act, and the reading experience ────────────────────────
  {
    const rows = () => [...first.querySelectorAll('.chat-msg')];
    await until(() => rows().length);
    /* The ROW carries no controls at all. Three hover glyphs on every line of
     * a 306px card is most of the line, and hover does not exist on touch. */
    check('a message row has no controls on it', first.querySelector('.cm-msg-act') === null);
    rows()[0].click();
    await until(() => first.querySelector('.cm-bar'));
    const bar = first.querySelector('.cm-bar');
    check('selecting a message raises ONE action bar', first.querySelectorAll('.cm-bar').length === 1
      && rows()[0].classList.contains('is-sel'));
    /* Every button wears its key — which is how the keyboard layer is taught
     * without a page of documentation nobody reads. */
    check('…and every verb on it names its own key',
      [...bar.querySelectorAll('.cm-verb')].every((v) => v.querySelector('.cm-verb-key')));
    /* Offering `edit` on somebody else's line and then refusing it is worse
     * than not offering it. */
    const verbs = (n) => [...n.querySelectorAll('.cm-verb')].map((v) => v.textContent.replace(/^./, ''));
    const theirs = verbs(bar);
    check('…and shows only what is legal — no edit or delete on somebody else\'s message',
      !theirs.includes('edit') && !theirs.includes('delete') && theirs.includes('reply'),
      theirs.join(','));

    w.__HARNESS_EMIT__('matrix::timeline', { room_id: '!snc:h', messages: [{
      event_id: '$mine', sender: '@1-194:h', sender_name: 'Marklifer', self: true,
      kind: 'text', ts: Date.now(), body: 'mine to edit' }] });
    await until(() => rows().some((r) => /mine to edit/.test(r.textContent)));
    rows().find((r) => /mine to edit/.test(r.textContent)).click();
    await until(() => verbs(first.querySelector('.cm-bar')).includes('edit'));
    check('…while your own message offers edit and delete', true);

    // The keys and the buttons are ONE verb, so they cannot disagree.
    const before = (w.__HARNESS_CALLS__ || []).filter((c) => c.cmd === 'matrix_redact').length;
    first.querySelector('.cm-timeline').dispatchEvent(new w.KeyboardEvent('keydown', { key: 'd', bubbles: true }));
    await until(() => (w.__HARNESS_CALLS__ || []).filter((c) => c.cmd === 'matrix_redact').length > before);
    check('a key and its button are the same verb', true);
  }

  /* The "new messages" rule. THE most important reading affordance in any chat
   * client, and there was no way at all to tell what had arrived since you
   * last looked. Anchored from the count the SERVER was carrying, captured
   * before marking read — because marking is what destroys the answer. */
  check('a room opened with unread draws a rule where you left off',
    typeof w.BoardComms.anchorUnread === 'function'
    && w.BoardComms.S.lastRead['!snc:h'] !== undefined);

  /* Your own message appears the INSTANT you send it, dimmed, and then
   * confirms or fails. Waiting for the round trip made the composer feel
   * broken, and a send that failed simply vanished. */
  {
    const input = first.querySelector('textarea, input[type="text"]');
    input.value = 'echo test';
    input.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    const echoed = (w.BoardComms.S.timelines['!snc:h'] || []).filter((m) => m.body === 'echo test');
    check('a sent message is on screen before the server has answered',
      echoed.length === 1 && String(echoed[0].event_id).charAt(0) === '~');
    /* A local id is not a server id, so an echo can never be mistaken for
     * something the server knows about — the read marker refuses it. */
    check('…and its local id can never be mistaken for a server event',
      !String(echoed[0].event_id).startsWith('$'));
  }

  /* What you typed and did not send. Switching cards used to lose it. */
  {
    const input = first.querySelector('textarea, input[type="text"]');
    input.value = 'half a thought';
    input.dispatchEvent(new w.Event('input', { bubbles: true }));
    check('an unsent draft is kept per room', w.BoardComms.draft('!snc:h') === 'half a thought');
    input.value = '';
    input.dispatchEvent(new w.Event('input', { bubbles: true }));
    check('…and dropped once the box is empty', w.BoardComms.draft('!snc:h') === '');
  }

  ids.forEach((i) => T.remove(i));
  /* One subscription for the whole window. Four Comms cards each wiring their
   * own listeners is how one glance sends four read receipts. */
  /* One subscriber is meant to outlive every card: the Terminal-wide watcher
   * on document.body that paints the mention badge and answers show_room. So
   * "no card is drawn into" means no subscriber whose host is a CARD. */
  check('every card shares ONE live subscription, and a removed card stops being drawn into',
    w.BoardComms.S.subs.filter((f) => f.host && f.host !== d.body && f.host.isConnected).length === 0);
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

  /* Comms is DECENTRALISED — every guild runs its own homeserver — and the
   * number of guilds is unbounded. One TAB per guild was a menu that grew
   * without limit and made a new player pick a server before they knew what a
   * server was. There is ONE list now: every guild's directory, fanned out and
   * merged, ranked so the hub's rooms and the big rooms are on top, with the
   * guild named on each row. No other Matrix client can do this; we know the
   * whole set of homeservers from chain. */
  {
    const browses = () => (w.__HARNESS_CALLS__ || []).filter((c) => c.cmd === 'matrix_browse');
    check('no server strip — a guild is not a tab', dir.querySelector('.subnav') === null);
    check('every guild that publishes a homeserver was asked, in one go',
      browses().some((c) => c.args.server === 'oh.energy') && browses().some((c) => !c.args.server));
    const rows = [...dir.querySelectorAll('.cm-room')];
    check('…and their rooms stand in one list, each saying which guild',
      rows.some((r) => /Hydro General/.test(r.textContent) && /Orbital Hydro/.test(r.querySelector('.cm-room-where').textContent))
      && rows.some((r) => /Help/.test(r.textContent) && /SN Corp/.test(r.querySelector('.cm-room-where').textContent)),
      rows.map((r) => r.textContent.replace(/\s+/g, ' ')).join(' | '));
    check('the biggest room is on top — "where does everyone talk" answers itself',
      /Hydro General/.test(rows[0].textContent));
    check('…and the caption says how many guilds answered', /2 of 2 guilds/.test(dir.textContent), dir.textContent.replace(/\s+/g, ' ').slice(0, 80));
    /* Search is IN the card, where a person looks for it — and it is the same
     * `q` ⌘K's `CHANNELS <text>` sets, so the two cannot disagree. */
    const box = dir.querySelector('.cm-find-input');
    check('a search box stands at the top of the directory', box !== null);
    /* A guild is a SUBJECT. `CHANNELS OH` is that guild's directory, whole. */
    const n0 = browses().length;
    box.value = 'OH';
    box.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await until(() => browses().length > n0);
    await until(() => /OH|Orbital Hydro/.test(d.querySelector('#tm-' + cid + ' .tm-title').textContent));
    check('naming a guild scopes the directory to that guild\'s server, and says so',
      browses().slice(n0).every((c) => c.args.server === 'oh.energy')
      && /Orbital Hydro only/.test(d.querySelector('#tm-' + cid).textContent), d.querySelector('#tm-' + cid).textContent.replace(/\s+/g, ' ').slice(0, 100));
    /* Anything else is a SEARCH, on every guild at once. */
    const n1 = browses().length;
    T.setParams(cid, { q: 'trade' });
    await until(() => browses().length >= n1 + 2);
    check('any other word searches every guild\'s directory for it',
      browses().slice(n1).every((c) => c.args.query === 'trade') && browses().slice(n1).length === 2);
    T.setParams(cid, { q: '' });
    await until(() => [...d.querySelectorAll('#tm-' + cid + ' .cm-room')].some((r) => /Hydro General/.test(r.textContent)));
  }

  /* Joining from the directory. `matrix_join` answers `{ ok: true }` and the
   * room reaches the list on the NEXT sync — so the card must show a room in
   * the "joined, not in sync yet" state, not an error, and then become the
   * real room when `matrix::rooms` lands. This turned every directory join
   * into "nothing joined" for as long as the fixture pretended otherwise. */
  {
    const before = T.state.layout.cards.length;
    // The directory is on the OTHER guild's server by now — so this is a
    // federated join, which is the case that matters.
    [...d.querySelectorAll('#tm-' + cid + ' .cm-room')].find((r) => /Hydro General/.test(r.textContent)).click();
    await until(() => T.state.layout.cards.length === before + 1);
    const rc = T.state.layout.cards.slice(-1)[0];
    await until(() => d.querySelector('#tm-' + rc.id + ' .sui-message-inline-alert, #tm-' + rc.id + ' .cm-timeline'));
    const card = d.querySelector('#tm-' + rc.id);
    check('a join the server accepted is not an error, even before sync has the room',
      /waiting for the room to arrive/.test(card.textContent) && !/nothing joined/.test(card.textContent)
      // …and it is CALLED by its alias's local part, never the raw address.
      && !/#general:oh\.energy/.test(card.textContent) && /Orbital Hydro/.test(card.textContent),
      card.textContent.replace(/\s+/g, ' ').slice(0, 120));
    // The sync lands: the room list now carries the room, by the alias we asked for.
    w.__HARNESS_EMIT__('matrix::rooms', { guild_id: '0-5', rooms: w.BoardComms.S.rooms.concat([
      { room_id: '!hydro:oh.energy', name: 'Hydro General', canonical_alias: '#general:oh.energy',
        section: 'galaxy', joined: true, members: 400, unread: 0, mention: false, icon: 'icon-guild' },
    ]) });
    await until(() => !/not come back in a sync yet/.test(d.querySelector('#tm-' + rc.id).textContent));
    check('…and becomes the real room when the sync lands — across servers',
      /Hydro General/.test(d.querySelector('#tm-' + rc.id + ' .tm-title').textContent)
      && (w.__HARNESS_CALLS__ || []).some((c) => c.cmd === 'matrix_timeline' && c.args.roomId === '!hydro:oh.energy'));
    T.remove(rc.id);
  }

  T.add('who', { id: '!snc:h' }, 1);
  const wid = T.state.layout.cards.slice(-1)[0].id;
  await until(() => d.querySelector('#tm-' + wid + ' .pc-row'));
  const who = d.querySelector('#tm-' + wid);
  check('WHO draws room members as PEOPLE, with the same face the roster shows',
    who.querySelectorAll('.pc-row').length === 3 && /JPEG/.test(who.textContent));
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
  check('…and opens it AT the message, not at the newest line',
    T.state.layout.cards.some((c) => c.type === 'room' && c.params.id === '!snc:h' && c.params.at === '$h1'));
  /* An empty FIND is a search box, not a note telling you to find one. */
  T.add('find', {}, 1);
  const fid = T.state.layout.cards.slice(-1)[0].id;
  await until(() => d.querySelector('#tm-' + fid + ' .cm-find-input'));
  check('an empty FIND card is a search box', d.querySelector('#tm-' + fid + ' .cm-find-input') !== null);
  /* A room opened at a message selects it. */
  T.add('room', { id: '!snc:h', at: '$m1' }, 1);
  const aid = T.state.layout.cards.slice(-1)[0].id;
  await until(() => d.querySelector('#tm-' + aid + ' [data-event="$m1"].is-sel'));
  check('…and a room opened at a message has that message selected, with the bar up',
    d.querySelector('#tm-' + aid + ' .cm-bar') !== null);
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
    idle.length && idle[0].sub === 'SN.Corporation' && idle[0].group === 'Unread'
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

// ── What sixteen players asked for ─────────────────────────────────────────
//
// proposals/comms-player-review.md: the same interface reviewed by a grandma,
// a raider mid-siege, a screen-reader user, a returning player… What they
// converged on is tested here, by the thing they asked for.
{
  console.log('\n— what sixteen players asked for');
  const dom = await load('?view=terminal');
  const w = dom.window, d = w.document;
  const T = w.Board.Terminal, C = w.BoardComms;
  await T.enter();
  T.state.layout.cards.slice().forEach((c) => T.remove(c.id));
  await C.status(); await C.rooms();
  const calls = (cmd) => (w.__HARNESS_CALLS__ || []).filter((c) => c.cmd === cmd);

  /* 1. A DOOR. Five of sixteen could not find chat: the only way in was a key
   * chord and a word, and the badge appeared only once you had been named. */
  await until(() => d.querySelector('.cm-door'));
  check('a Comms door stands on the Terminal header before anything is waiting',
    d.querySelector('#tm-ws-doors .cm-door') !== null && /Comms/.test(d.querySelector('.cm-door').textContent)
    && d.querySelector('.cm-door .cm-badge') === null);
  d.querySelector('.cm-door').click();
  await until(() => T.state.layout.cards.some((c) => c.type === 'comms'));
  check('…and opens the Comms card', T.state.layout.cards.filter((c) => c.type === 'comms').length === 1);
  const cid = T.state.layout.cards.find((c) => c.type === 'comms').id;
  await until(() => d.querySelector('#tm-' + cid + ' .cm-room'));
  d.querySelector('.cm-door').click();
  check('…and a second click focuses the one there is rather than complaining',
    T.state.layout.cards.filter((c) => c.type === 'comms').length === 1
    && d.querySelector('#tm-' + cid).classList.contains('is-flash'));

  /* 2. The count reaches you where you are looking — the door, and the
   * window's own title behind whatever else is open. */
  const title0 = d.title;
  w.__HARNESS_EMIT__('matrix::unread', { count: 7, mention: false });
  await until(() => d.querySelector('.cm-door .cm-badge'));
  check('the door wears the count', d.querySelector('.cm-door .cm-badge').textContent === '7');
  check('…and so does the window title', d.title === '(7) ' + title0, d.title);
  w.__HARNESS_EMIT__('matrix::unread', { count: 0, mention: false });
  await until(() => !d.querySelector('.cm-door .cm-badge'));
  check('…and both let go when nothing is waiting', d.title === title0);

  /* 3. Words that say what they hold, and one name per server. */
  check('sections are named by their contents', C.GROUPS.map((g) => g.label).join('|') === 'Invited|Pinned|Unread|Everything else');
  await until(() => C.S.servers && C.S.servers.length);
  check('a server is called by its guild\'s name, everywhere', C.serverName('oh.energy') === 'Orbital Hydro' && C.serverName('nowhere') === 'nowhere');
  check('a room is never called by its raw address',
    C.title({ name: '#sncorp:matrix.beta.playstructs.com' }) === '#sncorp'
    && C.title({ name: '', canonical_alias: '#trade:h' }) === '#trade'
    && C.title({ name: 'Trade', canonical_alias: '#trade:h' }) === 'Trade');
  const card = d.querySelector('#tm-' + cid);
  check('a row\'s subtitle is a topic or an alias — never `#trade:h`',
    [...card.querySelectorAll('.cm-room-sub')].some((n) => n.textContent === '#trade')
    && ![...card.querySelectorAll('.cm-room-sub')].some((n) => /:h$/.test(n.textContent)));
  check('a private conversation looks private in the list',
    [...card.querySelectorAll('.cm-room.is-direct')].some((r) => /DM/.test(r.querySelector('.cm-room-where').textContent)));

  /* 4. A level between everything and nothing: mentions only. */
  check('a busy channel can be set to mentions only', C.setLevel('!trade:h', 'mentions') === 'mentions'
    && C.sectionOf(C.roomById('!trade:h')) === 'quiet' && C.calls(C.roomById('!trade:h')) === false);
  check('…so its traffic stops counting, while a mention still does',
    C.waiting().unread === 4 && C.calls(C.roomById('!snc:h')) === true);
  C.setLevel('!trade:h', 'all');
  check('…and it comes back', C.sectionOf(C.roomById('!trade:h')) === 'waiting' && C.waiting().unread === 13);

  /* 5. Everything read, in one act — not one open per room. */
  const reads0 = calls('matrix_mark_read').length;
  await until(() => card.querySelector('.cm-readall'));
  card.querySelector('.cm-readall').click();
  await until(() => calls('matrix_mark_read').length >= reads0 + 4);
  const marked = calls('matrix_mark_read').slice(reads0).map((c) => c.args.roomId).sort();
  // ALL means all — the muted room's 400 go too. And the receipt names an event.
  check('mark all read sends a receipt for every room carrying a count, the muted one included',
    marked.join(' ') === '!dm-jpeg:h !noise:h !snc:h !trade:h'
    && calls('matrix_mark_read').slice(reads0).every((c) => c.args.eventId === '$m1'), marked.join(' '));

  /* 6. The list has keys, like the conversation does. */
  // The rows' parent is the card body the keys live on (the card HEAD is focusable too).
  const body = card.querySelector('.cm-room').parentNode;
  check('the room list is focusable', body.tabIndex === 0);
  body.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  await until(() => card.querySelector('.cm-room.is-cursor'));
  const first = card.querySelector('.cm-room.is-cursor');
  body.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  await until(() => card.querySelector('.cm-room.is-cursor') !== first);
  const rooms0 = T.state.layout.cards.filter((c) => c.type === 'room').length;
  body.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await until(() => T.state.layout.cards.filter((c) => c.type === 'room').length === rooms0 + 1);
  check('↑/↓ walk the room list and Enter opens the one under the cursor', true);
  T.state.layout.cards.filter((c) => c.type === 'room').forEach((c) => T.remove(c.id));

  /* 7. Pins are SHOWN — the noticeboard, first — newest on top, folded past three. */
  w.__HARNESS_PINS__ = [1, 2, 3, 4].map((i) => ({ event_id: '$p' + i, sender_name: 'Marklifer', body: 'order ' + i }));
  w.__HARNESS_EMIT__('matrix::rooms', { guild_id: '0-5', rooms: C.S.rooms.map((r) => r.room_id === '!snc:h' ? Object.assign({}, r, { pinned: ['$p1', '$p2', '$p3', '$p4'] }) : r) });
  T.add('room', { id: '!snc:h' }, 1);
  const rid = T.state.layout.cards.slice(-1)[0].id;
  await until(() => d.querySelectorAll('#tm-' + rid + ' .cm-pin').length === 3);
  const rc = d.querySelector('#tm-' + rid);
  check('a room opens with its pins showing, newest first, three of them',
    rc.querySelector('.cm-pin .cm-pin-body').textContent === 'order 4' && /1 more pinned/.test(rc.querySelector('.cm-pins-more').textContent));
  rc.querySelector('.cm-pins-more').click();
  await until(() => d.querySelectorAll('#tm-' + rid + ' .cm-pin').length === 4);
  check('…and the rest unfold', true);
  check('the header says where, by name — not `#snc:h`',
    /#snc · SN Corp/.test(rc.querySelector('.cm-head-line').textContent), rc.querySelector('.cm-head-line').textContent);

  /* 8. The bar can be read aloud. */
  await until(() => rc.querySelector('[data-event="$m1"]'));
  rc.querySelector('[data-event="$m1"]').click();
  await until(() => rc.querySelector('.cm-bar'));
  check('the action bar and its verbs carry names a screen reader can say',
    rc.querySelector('.cm-bar').getAttribute('role') === 'toolbar'
    && [...rc.querySelectorAll('.cm-verb')].every((a) => /key/.test(a.getAttribute('aria-label')))
    && rc.querySelector('[data-event="$m1"]').getAttribute('aria-selected') === 'true');

  /* 9. A picture is shown, not described. */
  const media0 = calls('matrix_media').length;
  w.__HARNESS_EMIT__('matrix::timeline', { room_id: '!snc:h', messages: [{ event_id: '$img', sender: '@1-61:h', sender_name: 'JPEG', kind: 'image', ts: 2, body: 'map.png', mxc: 'mxc://h/abc' }] });
  await until(() => calls('matrix_media').length > media0);
  check('an image message asks for its bytes once', calls('matrix_media').slice(-1)[0].args.mxc === 'mxc://h/abc');
  await until(() => rc.querySelector('[data-event="$img"] img.chat-image-img'));
  check('…and draws the picture when they land',
    /^data:image\/png/.test(rc.querySelector('[data-event="$img"] img.chat-image-img').src));
  w.__HARNESS_EMIT__('matrix::timeline', { room_id: '!snc:h', messages: [{ event_id: '$img2', sender: '@1-61:h', sender_name: 'JPEG', kind: 'image', ts: 3, body: 'map2.png', mxc: 'mxc://h/abc' }] });
  await until(() => rc.querySelector('[data-event="$img2"] img.chat-image-img'));
  check('…and the same picture again costs nothing', calls('matrix_media').length === media0 + 1);

  /* 10. WHO: present first. */
  T.add('who', { id: '!snc:h' }, 1);
  const wid = T.state.layout.cards.slice(-1)[0].id;
  await until(() => d.querySelectorAll('#tm-' + wid + ' .pc-row, #tm-' + wid + ' [data-player]').length >= 3 || /here/.test(d.querySelector('#tm-' + wid).textContent));
  const who = d.querySelector('#tm-' + wid);
  check('WHO says how many are here and puts them first',
    /1 here · 3 members/.test(who.textContent) && who.textContent.indexOf('JPEG') < who.textContent.indexOf('Beezhan'), who.textContent.replace(/\s+/g, ' ').slice(0, 80));

  /* 11. ⌘K: a GUILD is a subject of CHANNELS — typed, not known. */
  const gl = T.commsRows('CHANNELS ');
  check('`CHANNELS ` lists every guild that publishes a homeserver, by name',
    gl.filter((r) => r.group === 'Guilds').length === 2
    && gl.some((r) => r.line === 'CHANNELS OH' && r.sub === 'Orbital Hydro')
    && gl.some((r) => r.line === 'CHANNELS SNC' && /your guild/.test(r.what)), JSON.stringify(gl.map((r) => r.line)));
  check('…and narrows as you type', T.commsRows('CHANNELS hyd').length === 1 && T.commsRows('CHANNELS hyd')[0].sub === 'Orbital Hydro'
    && T.commsRows('CHANNELS trade').filter((r) => r.group === 'Guilds').length === 0);

  /* 12. ⌘K: read all as one row; a level per row. */
  const rows = T.commsRows('');
  const all = rows.find((r) => r.acts && r.acts.some((a) => a.label === 'read all'));
  check('an empty ⌘K offers to read everything in one act', all !== undefined && all.group === 'Unread');
  const trade = rows.find((r) => r.sub === 'Trade');
  check('…and a channel row can be set to mentions only from there',
    trade !== undefined && trade.acts.some((a) => a.label === 'mentions only')
    && !rows.find((r) => r.sub === 'JPEG').acts.some((a) => /mentions/.test(a.label)));
  dom.window.close();
}

// ── The connective tissue: knowing where you are while three windows move ──
{
  console.log('\n— the surfaces know about each other');
  const dom = await load('?view=terminal');
  const w = dom.window, d = w.document;
  const T = w.Board.Terminal, C = w.BoardComms;
  await T.enter();
  T.state.layout.cards.slice().forEach((c) => T.remove(c.id));

  /* SAY is the one verb that is not a card. Mid-raid: ⌘K, say it, back to the
   * map — without opening, focusing or leaving anything. */
  check('SAY parses as an action, to the last room or to a named one',
    T.parse('SAY 2-15361 is breached').kind === 'say' && T.parse('SAY 2-15361 is breached').subject === undefined
    && T.parse('SAY #trade ore for capacity').subject === '#trade'
    && T.parse('SAY #trade ore for capacity').text === 'ore for capacity'
    && T.parse('SAY') === null);
  T.add('room', { id: '!snc:h' }, 1);
  await until(() => C.lastRoom() === '!snc:h');
  check('…and a room you looked at is where a bare SAY goes', C.lastRoom() === '!snc:h');
  const sends = () => (w.__HARNESS_CALLS__ || []).filter((c) => c.cmd === 'matrix_send');
  const n0 = sends().length;
  T.execute('SAY shields up');
  await until(() => sends().length > n0);
  check('…so SAY sends there without a card being opened', sends().slice(-1)[0].args.roomId === '!snc:h'
    && sends().slice(-1)[0].args.body === 'shields up');

  /* The room list is a map of the board: a room with a card says so. */
  T.add('comms', {}, 1);
  const cid = T.state.layout.cards.slice(-1)[0].id;
  await until(() => d.querySelector('#tm-' + cid + ' .cm-room.is-active'));
  check('a room that has a card on the board is marked in the list',
    /SN.Corporation/.test(d.querySelector('#tm-' + cid + ' .cm-room.is-active').textContent));

  /* Being named reaches the Terminal. `matrix::unread` went to the game
   * window's door and nowhere else — the surface this was built for had no
   * idea. */
  w.__HARNESS_EMIT__('matrix::unread', { count: 4, mention: true });
  await until(() => d.querySelector('.cm-badge'));
  check('a mention puts a badge on the workspace strip', d.querySelector('.cm-badge.is-mention') !== null
    && d.querySelector('.cm-badge').textContent === 'YOU');
  w.__HARNESS_EMIT__('matrix::unread', { count: 0, mention: false });
  await until(() => !d.querySelector('.cm-badge'));
  check('…and it goes when there is nothing waiting', true);

  /* "Look at #war-room" from the agent used to do nothing at all. */
  const rooms = () => d.querySelectorAll('#tm-grid [data-type="room"]').length;
  const r0 = rooms();
  w.__HARNESS_EMIT__('matrix::show_room', { guild_id: '0-5', room_id: '!snc:h' });
  await until(() => d.querySelector('#tm-grid .tm-card.is-flash'));
  check('show_room for a room with a card flashes that card rather than adding another',
    rooms() === r0 && d.querySelector('.tm-card.is-flash [data-type], .tm-card.is-flash') !== null);
  w.__HARNESS_EMIT__('matrix::show_room', { guild_id: '0-5', room_id: '!trade:h' });
  await until(() => rooms() === r0 + 1);
  check('…and for a room with no card, adds one', T.state.layout.cards.some((c) => c.type === 'room' && c.params.id === '!trade:h'));

  /* An edit says what it WAS. */
  w.__HARNESS_EMIT__('matrix::timeline', { room_id: '!snc:h', messages: [{ event_id: '$e1', sender: '@1-61:h', sender_name: 'JPEG', kind: 'text', ts: Date.now(), body: 'attack at dawn' }] });
  await until(() => (C.S.timelines['!snc:h'] || []).some((m) => m.event_id === '$e1'));
  w.__HARNESS_EMIT__('matrix::edited', { guild_id: '0-5', room_id: '!snc:h', event_id: '$e1', body: 'attack at dusk' });
  await until(() => C.S.timelines['!snc:h'].find((m) => m.event_id === '$e1').edited);
  const first = d.querySelector('#tm-grid [data-type="room"]');
  await until(() => first.querySelector('[data-event="$e1"] .chat-msg-edited'));
  /* IN the row, not in a tooltip: a hover is a fact only a mouse can reach. */
  check('an edited message says what it used to say, in the row',
    /before: attack at dawn/.test(first.querySelector('[data-event="$e1"] .cm-was').textContent));

  /* Palette rows: the room leads, the word follows, and a waiting row can be
   * dealt with without opening it. */
  const rows = T.commsRows('', C.S.rooms);
  const row = rows.find((r) => r.group === 'Unread' && r.words === 'ROOM');
  check('a waiting row leads with the ROOM and carries verbs', row.lead === true && row.acts.some((a) => a.label === 'read')
    && row.acts.some((a) => /mute/.test(a.label)));
  /* And SAY is a row you can SEE — `suggestFor` lists only words that open a
   * card, and SAY opens nothing. An empty box says where it would go. */
  check('an empty box shows where SAY would go', rows[0].group === 'Say' && /SN.Corporation/.test(rows[0].sub));
  check('prose in the box is a message search, a word is not',
    T.saidRows('shield is down').length === 0 /* nothing cached yet */ && T.parse('shield is down') === null
    && typeof T.saidRows === 'function');
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
