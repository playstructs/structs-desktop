// Simulator challenges in Comms, and Comms in the simulator.
//
//   node scripts/harness-tests/simchat.test.mjs
//
// 1. Rust and the simulator agree on the rules revision a ladder groups by.
// 2. The challenge card (frontend/simcard.js): row, card, result row, the
//    battle in miniature, in every state the canvas named.
// 3. The timeline wiring (frontend/chat-sim.js): a challenge's thread folds
//    into its card; only a run that took first place reaches the room.
// 4. The simulator page (simulator.html + simulator-social.js) against a
//    stub Tauri: a challenge opens locked with its panel, a best posts itself
//    into the thread, a battle addressed to a player is sent to them, Post
//    to… lists rooms and posts by codes alone, and Play live opens a match
//    with a player or in a room.
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(resolve(repo, p), 'utf8');
let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? '  ok ' : 'FAIL ') + name + (ok || detail == null ? '' : ' — ' + detail));
  if (!ok) failures++;
}
const text = (n) => (n ? n.textContent.replace(/\s+/g, ' ').trim() : '');
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/* ── 1. One rules revision ─────────────────────────────────────────────── */
{
  console.log('\n— the rules revision');
  const rs = /pub const RULES_REVISION: u8 = (\d+);/.exec(read('src-tauri/src/matrix/sim.rs'));
  const js = /var RULES_REVISION = (\d+);/.exec(read('frontend/simcode.js'));
  check('matrix/sim.rs and simcode.js rank on the same rules revision', rs && js && rs[1] === js[1], (rs && rs[1]) + ' vs ' + (js && js[1]));
  check('…and post the same site', /pub const SITE: &str = "https:\/\/structs\.app\/sim\/";/.test(read('src-tauri/src/matrix/sim.rs'))
    && /var BASE = 'https:\/\/structs\.app\/sim\/';/.test(read('frontend/simcode.js')));
}

/* ── 2. The card ───────────────────────────────────────────────────────── */
const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' });
const w = dom.window;
for (const f of ['pfp.js', 'playercard.js', 'guildcard.js', 'structs-cards.js', 'simcode.js', 'simulator-types.js', 'battle-art.js', 'simcard.js', 'chatrow.js', 'chat-sim.js']) w.eval(read('frontend/' + f));
const Card = w.StructsSimCard, Code = w.StructsSimCode;

// A Difficult 9 v 9 on "spearpoint", as the simulator lays one out.
const fleetTypes = Object.fromEntries(w.SimulatorTypes.types.map((t) => [t.type, t.id]));
function unit(side, type, ambit, slot, protects = null) {
  const cmd = type === 'Command Ship';
  return { id: side + '-' + (cmd ? 'cmd' : ambit + '-' + slot), side, type: fleetTypes[type], ambit, slot: cmd ? 0 : slot, protects };
}
const units = [];
for (const side of ['player', 'computer']) {
  units.push(unit(side, 'Command Ship', 'land', 0));
  units.push(unit(side, 'Battleship', 'space', 0, side + '-cmd'), unit(side, 'Starfighter', 'space', 1));
  units.push(unit(side, 'Pursuit Fighter', 'air', 0), unit(side, 'Stealth Bomber', 'air', 1));
  units.push(unit(side, 'Mobile Artillery', 'land', 0), unit(side, 'Tank', 'land', 1));
  units.push(unit(side, 'Cruiser', 'water', 0), unit(side, 'Destroyer', 'water', 1));
}
const config = { version: 3, seed: 'spearpoint', difficulty: 'difficult', blockMs: 2000, charge: { player: 9, computer: 9 }, units };
const battle = Code.encode(config);
const result = (winner, lost, blocks, seconds) => Code.encodeResult({ winner, blocks, seconds, stats: { player: { lost, attacks: 20 }, computer: { lost: 5 } } });
const outcome = (verdict, winner, time, lost) => ({ verdict, winner, time, lost, fielded: 9, blocks: 76, current: true, revision: 1 });
const frame = { v: 1, kind: 'challenge', battle, name: 'Spearpoint', difficulty: 'difficult', block_ms: 2000, units: [9, 9], link: 'https://structs.app/sim/' + battle };
const me = '@1-1:h';
const entry = (rank, sender, name, o) => ({ rank, sender, name, player_id: sender.slice(1, sender.indexOf(':')), outcome: o, result: 'x' });

{
  console.log('\n— the battle in miniature');
  const b = Card.board(battle);
  const bands = b ? b.querySelectorAll('.chl-band') : [];
  check('four bands, space to water', bands.length === 4 && ['space', 'air', 'land', 'water'].every((a, i) => bands[i].classList.contains('chl-' + a)));
  check('…each: command column, four slots, the ambit, four slots, command column', [...bands].every((n) => n.querySelectorAll('.chl-cell').length === 10 && n.querySelector('.chl-amb')));
  check('…eighteen structs drawn, both command ships on land', b.querySelectorAll('.chl-cell.chl-full').length === 18
    && bands[2].querySelectorAll('.chl-cell.chl-full').length === 6);
  check('…from the game\'s own struct art', [...b.querySelectorAll('img.chl-art')].every((i) => /^img\/structs\/[a-z-]+\/[a-z-]+-struct-base\.png$/.test(i.getAttribute('src'))));
  check('…defenders carry the defending mark', b.querySelectorAll('.sui-icon-defending').length === 2);
  check('…and a code that is not a battle draws nothing', Card.board('nonsense') === null);
}

{
  console.log('\n— the row, in every state');
  const open = Card.row({ frame, me });
  check('unplayed: name, difficulty badge, "9 v 9 · unplayed", live stripe', text(open.querySelector('.pc-nm')) === 'Spearpoint'
    && text(open.querySelector('.sui-badge')) === 'Difficult' && /9 v 9 · unplayed/.test(text(open.querySelector('.pc-id'))) && open.classList.contains('sc-live'));
  check('…no battle code anywhere a person reads', !text(open).includes(battle));

  const played = { frame, me, ladder: [entry(1, '@1-9:h', 'T.Xue', outcome('Victory', 'player', '02:41', 1)), entry(2, '@1-61:h', 'JPEG', outcome('Victory', 'player', '03:14', 2))] };
  const row = Card.row(played, { onPlay: () => {}, onMore: () => {} });
  check('played: "4 played · best" and the best time as the reading', /2 played · best T.Xue/.test(text(row.querySelector('.pc-id'))) && text(row.querySelector('.pc-res')) === '02:41');
  check('…one verb (Play) and the menu', [...row.querySelectorAll('.pc-act')].map((a) => a.title).join(',') === 'Play Spearpoint,More');

  const forYou = Card.row({ frame: Object.assign({}, frame, { to: [me], outcome: outcome('Victory', 'player', '02:55', 2) }), me, author: { name: 'Marklifer', self: false } });
  check('addressed to you: For you, from whom, the time to beat', Card.state({ frame: Object.assign({}, frame, { to: [me] }), me, author: { self: false } }) === 'for-you'
    && text(forYou.querySelector('.sui-badge')) === 'For you' && /from Marklifer · to beat 02:55/.test(text(forYou.querySelector('.pc-id'))) && forYou.classList.contains('sc-warn'));

  const mine = { frame, me, ladder: [entry(1, me, 'Marklifer', outcome('Victory', 'player', '02:31', 1)), entry(2, '@1-9:h', 'T.Xue', outcome('Victory', 'player', '02:41', 1))] };
  check('holding first: Your best, "1st of 2"', Card.state(mine) === 'best' && /1st of 2/.test(text(Card.row(mine).querySelector('.pc-id')))
    && text(Card.row(mine).querySelector('.sui-badge')) === 'Your best');
  const beaten = Object.assign({}, played, { beaten: true, ladder: played.ladder.concat([entry(3, me, 'Marklifer', outcome('Victory', 'player', '03:30', 3))]) });
  check('knocked off: Beaten, theirs against yours, red stripe', Card.state(beaten) === 'beaten' && /T.Xue 02:41 · you 03:30/.test(text(Card.row(beaten).querySelector('.pc-id'))) && Card.row(beaten).classList.contains('sc-bad'));

  const shared = Card.resultRow({ frame: Object.assign({}, frame, { kind: 'result', outcome: outcome('Defeat', 'computer', '05:02', 9) }), author: { name: 'Korrin' } });
  check('a shared result leads with the verdict, the battle as its badge', text(shared.querySelector('.pc-nm')) === 'Defeat' && text(shared.querySelector('.sui-badge')) === 'Spearpoint'
    && /05:02 · lost 9 of 9 · 76 blocks · Korrin/.test(text(shared.querySelector('.pc-id'))) && shared.classList.contains('sc-bad'));
}

{
  console.log('\n— the card');
  let played = 0, replies = 0;
  const view = { frame, me, author: { name: 'JPEG', self: false }, reply_count: 3, replies: [{ name: 'Netlag', body: 'the cruiser block on 49 is the whole fight' }],
    ladder: [entry(1, '@1-9:h', 'T.Xue', outcome('Victory', 'player', '02:41', 1)), entry(2, me, 'Marklifer', outcome('Victory', 'player', '02:55', 2)), entry(3, '@1-1031:h', 'Korrin', outcome('Defeat', 'computer', '05:02', 9))] };
  const c = Card.card(view, { onPlay: () => played++, onReplies: () => replies++, onCopy: () => {}, onMore: () => {}, onCollapse: () => {} });
  check('the planet-card frame: name, who and how, no battle code', c.classList.contains('sui-planet-card') && text(c.querySelector('.pc-nm')) === 'Spearpoint'
    && /JPEG · 9 v 9 · 2 s blocks/.test(text(c.querySelector('.pc-id'))) && !text(c).includes(battle));
  const stats = [...c.querySelectorAll('.chl-stat')].map((n) => text(n.querySelector('.chl-stat-v')) + ' ' + text(n.querySelector('.chl-stat-l'))).join(' · ');
  check('…the miniature, the tallies, the ladder', c.querySelector('.chl-board') && stats === '3 Played · 2 Won · 02:41 Best' && c.querySelectorAll('.chl-run').length === 3, stats);
  check('…you are marked on the ladder', c.querySelector('.chl-run.chl-me') && /Marklifer/.test(text(c.querySelector('.chl-run.chl-me'))));
  check('…the thread in one line', text(c.querySelector('.chl-replies')) === '3 replies' && /^Netlag the cruiser block/.test(text(c.querySelector('.chl-said'))));
  c.querySelector('.chl-play').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  c.querySelector('.chl-replies').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  check('…Play and the replies are wired', played === 1 && replies === 1);
  check('…doors: copy, more, collapse', [...c.querySelectorAll('.pc-act')].map((a) => a.title).join(',') === 'Copy link,More,Collapse');
}

/* ── 3. The timeline ───────────────────────────────────────────────────── */
{
  console.log('\n— the timeline');
  const S = { view: 'room', roomId: '!r:h', guildId: '0-1', profile: { user_id: me }, messages: [] };
  const asked = [];
  const sim = w.ChatSim({
    el: (tag, cls, t) => { const e = w.document.createElement(tag); if (cls) e.className = cls; if (t != null) e.textContent = t; return e; },
    icon: (name, size) => { const i = w.document.createElement('i'); i.className = 'sui-icon ' + (size || 'sui-icon-md') + ' ' + name; return i; },
    invoke: (cmd, args) => { asked.push([cmd, args]); return Promise.resolve(null); },
    render: () => {}, serverIdOf: (m) => m.event_id, S, Chat: {},
  });
  const root = { event_id: '$root', sender: '@1-61:h', sender_name: 'JPEG', body: 'Spearpoint · Difficult · 9 v 9 — ' + frame.link, sim: frame, ts: 1 };
  const talk = { event_id: '$talk', thread_root: '$root', body: 'gg', sender_name: 'Netlag', ts: 2 };
  const run = { event_id: '$run', thread_root: '$root', sender_name: 'Korrin', kind: 'notice', sim: Object.assign({}, frame, { kind: 'result', top: false }), ts: 3 };
  const best = { event_id: '$best', thread_root: '$root', sender_name: 'T.Xue', kind: 'notice', ts: 4,
    sim: Object.assign({}, frame, { kind: 'result', top: true, beat: me, outcome: outcome('Victory', 'player', '02:41', 1) }) };
  const stray = { event_id: '$stray', thread_root: '$elsewhere', body: 'hi', ts: 5 };
  S.messages = [root, talk, run, best, stray];
  check('talk and runs in a challenge\'s thread fold into its card', sim.folded(talk) && sim.folded(run));
  check('…a run that took first place stays in the room', !sim.folded(best));
  check('…a thread whose root is not a battle (or not loaded) is left alone', !sim.folded(stray) && !sim.folded(root));
  const line = sim.simLine(best);
  check('the new best is one event line addressed to the one it beat', line && line.classList.contains('chat-event') && line.classList.contains('chl-mine')
    && /T\.Xue beat your best on Spearpoint · Victory 02:41 · lost 1/.test(text(line)), text(line));
  check('…and an ordinary run draws no line', sim.simLine(run) === null);
  const node = sim.simNode(root);
  check('a challenge message draws its row and asks Rust for the ladder once', node && node.querySelector('.chl-row') && asked.filter((a) => a[0] === 'matrix_sim_thread').length === 1);
  sim.simNode(root);
  check('…not again on the next repaint', asked.filter((a) => a[0] === 'matrix_sim_thread').length === 1);
  check('the body this app wrote stands in for nothing the row does not say', sim.hidesBody(root));
  check('…a pasted bare link is hidden, a sentence with a link is kept', sim.hidesBody({ sim: Object.assign({ pasted: true }, frame), body: frame.link })
    && !sim.hidesBody({ sim: Object.assign({ pasted: true }, frame), body: 'beat this ' + frame.link }));
  node.querySelector('.pc-act').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  const play = asked.filter((a) => a[0] === 'sim_challenge_open')[0];
  check('Play hands the simulator the room, the thread and the battle — nothing else', play && play[1].roomId === '!r:h' && play[1].eventId === '$root' && play[1].battle === battle && Object.keys(play[1]).sort().join() === 'battle,eventId,guildId,roomId');
}

/* ── 4. The simulator ──────────────────────────────────────────────────── */
async function simulator(context, answers = {}) {
  const page = resolve(repo, 'frontend/simulator.html');
  const calls = [];
  const subs = {};
  let pending = context;
  const sdom = await JSDOM.fromFile(page, {
    url: pathToFileURL(page).href, runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true,
    beforeParse(sw) {
      sw.HTMLCanvasElement.prototype.getContext = () => null;
      sw.navigator.clipboard = { writeText: (t) => { (sw.__copied = sw.__copied || []).push(t); return Promise.resolve(); } };
      sw.__TAURI__ = {
        core: { invoke: (cmd, args) => {
          calls.push([cmd, args || {}]);
          if (cmd === 'sim_take_context') { const c = pending; pending = null; return Promise.resolve(c); }
          if (answers[cmd]) return Promise.resolve().then(() => answers[cmd](args || {}));
          return Promise.resolve(null);
        } },
        event: { listen: (name, cb) => { (subs[name] = subs[name] || []).push(cb); return Promise.resolve(() => {}); } },
      };
    },
  });
  const sw = sdom.window;
  for (let i = 0; i < 100 && !sw.Simulator; i++) await tick(20);
  await tick(50);
  // setPending(c): the next context Rust would hand over (Simulator.takeContext takes it).
  return { sw, calls, subs, $: (id) => sw.document.getElementById(id), setPending: (c) => { pending = c; }, close: () => sdom.window.close() };
}

{
  console.log('\n— the simulator, opened from a challenge');
  const thread = { room_name: 'SN.Corporation', me, author: { name: 'JPEG', pfp_attrs: null }, frame,
    ladder: [entry(1, '@1-9:h', 'T.Xue', outcome('Victory', 'player', '02:41', 1)), entry(2, me, 'Marklifer', outcome('Victory', 'player', '02:55', 2))],
    reply_count: 1, replies: [{ name: 'Netlag', body: 'guard the command ship with the tank', ts: 0 }] };
  const posts = [];
  const s = await simulator({ kind: 'challenge', guild_id: '0-1', room_id: '!r:h', event_id: '$root', battle }, {
    matrix_sim_thread: () => thread,
    matrix_sim_post: (a) => { posts.push(a); return { posted: true, event_id: '$mine', top: true, beat: '@1-9:h' }; },
  });
  await tick(50);
  const { sw, $ } = s;
  check('the challenge is taken on boot and its battle loaded', s.calls.some((c) => c[0] === 'sim_take_context') && sw.StructsSimCode.encode({
    version: 3, seed: $('seed').value, difficulty: sw.Simulator.getSettings().difficulty, blockMs: sw.Simulator.getSettings().blockMs,
    charge: sw.Simulator.getSettings().charge, units: sw.Simulator.getLayout() }) === battle);
  check('the Challenge panel takes the Round card\'s place', !$('challenge').classList.contains('hidden') && $('round').classList.contains('hidden'));
  check('…with the battle, who posted it, where, its settings', /Spearpoint/.test(text($('challenge'))) && /JPEG/.test(text($('challenge'))) && /SN\.Corporation/.test(text($('challenge')))
    && /Difficult/.test(text($('challenge'))) && /Charge 9 · 9/.test(text($('challenge'))));
  {
    // COMMAND DECK: the panel is a deck panel in the warning tone; its settings are pills.
    const ch = $('challenge');
    const head = ch.querySelector('.d-panel-h');
    check('…a deck panel: its header names it, an icon key leaves it', ch.matches('.d-panel.is-warn') && head && /^Challenge$/.test(text(head))
      && head.querySelector('button.d-iconbtn[aria-label="Leave the challenge"] i.sui-icon.icon-close'));
    check('…the battle\'s name, then who set it and where', /^Spearpoint$/i.test(text(ch.querySelector('h2.d-name')))
      && /JPEG/.test(text(ch.querySelector('.s-by'))) && /SN\.Corporation/.test(text(ch.querySelector('.s-by'))) && ch.querySelector('.s-by .d-pf'));
    const pills = [...ch.querySelectorAll('.s-pills .d-pill')].map(text);
    check('…its settings as pills from the code, difficulty with its chevrons', pills.join(' | ') === 'Difficult | 2 s | Charge 9 · 9'
      && ch.querySelector('.s-pills .d-pill .d-chevs'), pills.join(' | '));
    check('…and its fleets fixed', /^Fleets fixed$/.test(text(ch.querySelector('.s-lock'))) && ch.querySelector('.s-lock .icon-blocked'));
  }
  check('…the ladder is the Comms card\'s own, worn as deck rows, you marked', $('challenge').querySelectorAll('.chl-ladder.d-ladder .chl-run.d-lrow').length === 2
    && /You/.test(text($('challenge').querySelector('.chl-run.chl-me.is-me'))) && $('challenge').querySelector('.chl-run.is-me .d-lrow-name').title === 'Marklifer'
    && $('challenge').querySelectorAll('.chl-run .chl-verdict.sc-ok').length === 2 && !$('challenge').querySelector('.chl-run .chl-lost')
    && [...$('challenge').querySelectorAll('.chl-verdict')].every((v) => v.getAttribute('aria-label') === 'Victory' && v.querySelector('i.icon-success'))
    && /2 runs/.test(text($('challenge').querySelector('.d-sec-h'))),
    $('challenge').querySelector('.chl-ladder') && $('challenge').querySelector('.chl-ladder').outerHTML.slice(0, 600));
  check('…and the thread, read-only, as deck messages — talking is the Map Viewer\'s rail and Comms', /guard the command ship/.test(text($('challenge').querySelector('.sim-thread')))
    && /Netlag/.test(text($('challenge').querySelector('.sim-thread .d-msg .d-msg-h')))
    && !$('challenge').querySelector('textarea, input, .sim-reply'));
  check('the top bar\'s mode says Challenge', $('sim-mode').matches('.d-mode.is-challenge') && /^Challenge$/.test(text($('sim-mode'))) && $('sim-mode').querySelector('.icon-raid'));
  // W2-setup: the board, the inspector and the command bar under a challenge.
  check('the fleets are locked: Mirror and Swap switched off (not hidden), no chip, empty slots dead', !$('locked-chip')
    && $('mirror').disabled && $('swap').disabled && !$('mirror').classList.contains('hidden') && !$('swap').classList.contains('hidden')
    && !$('share').disabled
    && [...sw.document.querySelectorAll('#arena .slot')].filter((b) => !b.dataset.unit).every((b) => b.disabled));
  check('…and its empty slots draw no add mark', !sw.document.querySelector('#arena .slot:not([data-unit]) .d-tile-plus'));
  check('…the opening charges read fixed', $('charge-player').disabled && $('charge-cpu').disabled && /fixed by challenge/.test(text($('charges'))));
  const bs = sw.document.querySelector('#arena .slot[data-unit="player-space-0"]');
  bs.click();
  const keys = [...$('inspector').querySelectorAll('.d-key')];
  check('…a struct can be looked at but not changed: four keys, all off; the guard row off; tagged Fixed', /Battleship/i.test(text($('inspector').querySelector('.d-name')))
    && keys.length === 4 && keys.every((k) => k.disabled)
    && [...$('inspector').querySelectorAll('.d-guard button')].every((b) => b.disabled)
    && /Fixed/.test(text($('inspector').querySelector('.d-hero-tag')))
    && !$('inspector').querySelector('.sui-panel-btn, select'));
  check('…and the command bar reads the challenge', /^Spearpoint/.test(text($('checks').querySelector('.d-ready-d'))));
  check('…its best, once the thread lands: in the readiness and as the top bar\'s Best pill', /· best 02:41$/.test(text($('checks').querySelector('.d-ready-d')))
    && [...$('sim-status').querySelectorAll('.d-pill.is-amber')].some((p) => /^Best 02:41$/.test(text(p))), text($('checks')) + ' | ' + text($('sim-status')));

  // The Map Viewer's rail asks the simulator for its room and talks through it.
  const C = sw.Simulator.comms;
  const room = C('sim_comms_room', {});
  check('the rail beside the battle is given the challenge\'s thread', room && room.room_id === 'sim-thread:$root' && /Spearpoint · thread/.test(room.topic) && room.guild_id === '0-1');
  const tl = await C('matrix_timeline', { guildId: '0-1', roomId: room.room_id, limit: 40 });
  check('…reads its replies as chat rows', tl.messages.length === 1 && tl.messages[0].sender_name === 'Netlag' && tl.messages[0].kind === 'text');
  let refusedRoom = null;
  try { C('matrix_timeline', { guildId: '0-1', roomId: '!other:h' }); } catch (e) { refusedRoom = String(e.message || e); }
  check('…and no other room: the rail cannot be pointed elsewhere', /not this battle/.test(refusedRoom || ''));
  check('…nor any other command', C('matrix_leave', { roomId: room.room_id }) === undefined);
  await C('matrix_send', { guildId: '0-1', roomId: room.room_id, body: 'running it back', msgtype: null });
  await tick(20);
  const reply = s.calls.filter((c) => c[0] === 'matrix_sim_reply')[0];
  check('a message from the rail goes into this battle\'s thread and nowhere else', reply && reply[1].roomId === '!r:h' && reply[1].eventId === '$root' && reply[1].body === 'running it back');

  // A finished run, debriefed: as showDebrief hands it over.
  const mine = result('player', 1, 76, 151);
  sw.document.body.dataset.screen = 'debrief';
  sw.Simulator.social.debrief(JSON.parse(JSON.stringify(Object.assign({ preset: 'difficult' }, config))), mine);
  await tick(30);
  check('a best posts itself, into the thread, by codes alone', posts.length === 1 && posts[0].thread === '$root' && posts[0].battle === battle && posts[0].result === mine
    && Object.keys(posts[0]).sort().join() === 'battle,guildId,result,roomId,thread');
  check('…and the debrief says so in the teal alert band: what it was, where it went, an Undo', $('db-post').matches('.d-alert.is-teal') && !$('db-post').classList.contains('hidden')
    && /New best · posted/.test(text($('db-post').querySelector('.d-alert-h'))) && /was 02:55/.test(text($('db-post'))) && /to SN\.Corporation/.test(text($('db-post').querySelector('.d-alert-sub')))
    && /Undo/.test(text($('db-post').querySelector('button.d-tool'))), text($('db-post')));
  check('…and the debrief\'s Challenge panel is the compact deck panel, the ladder whole', $('db-challenge').matches('.d-panel.is-warn.x-chal') && !$('db-challenge').classList.contains('hidden')
    && $('db-challenge').querySelectorAll('.chl-run').length === 2 && !$('db-challenge').querySelector('.s-pills') && /^Fleets fixed · Difficult · 2 s$/.test(text($('db-challenge').querySelector('.d-panel-f')))
    && $('db-challenge').querySelector('.d-panel-f .icon-blocked'), text($('db-challenge').querySelector('.d-panel-f')));
  [...$('db-post').querySelectorAll('button')].filter((b) => /Undo/.test(b.textContent))[0].click();
  await tick(20);
  const undo = s.calls.filter((c) => c[0] === 'matrix_redact')[0];
  check('…Undo takes the post back', undo && undo[1].eventId === '$mine' && /Taken back/.test(text($('db-post'))));

  // Edited fleets are a different battle: never posted.
  const edited = JSON.parse(JSON.stringify(config)); edited.units.pop();
  sw.Simulator.social.debrief(edited, mine);
  await tick(20);
  check('a run on edited fleets is not the challenge and does not post', posts.length === 1 && /Your own battle/.test(text($('db-post'))));

  sw.document.body.dataset.screen = 'setup';
  check('Edit fleets sits in the Challenge panel\'s footer', $('unlock').closest('#challenge .d-panel-f') && !$('unlock').classList.contains('hidden'));
  $('unlock').click();
  check('Edit fleets opens the Round card and offers the way back', !$('round').classList.contains('hidden') && !$('relock').classList.contains('hidden') && $('challenge').classList.contains('hidden'));
  $('relock').click();
  check('…Back to the challenge locks it again', $('round').classList.contains('hidden') && !$('challenge').classList.contains('hidden'));
  s.close();
}

{
  console.log('\n— a battle that is not your best');
  const s = await simulator({ kind: 'challenge', guild_id: '0-1', room_id: '!r:h', event_id: '$root', battle }, {
    matrix_sim_thread: () => ({ me, frame, ladder: [entry(1, me, 'Marklifer', outcome('Victory', 'player', '02:31', 1))] }),
    matrix_sim_post: () => ({ posted: false, best: false }),
  });
  await tick(50);
  s.sw.document.body.dataset.screen = 'debrief';
  s.sw.Simulator.social.debrief(JSON.parse(JSON.stringify(config)), result('player', 2, 90, 185));
  await tick(30);
  check('Rust keeps it, and the debrief says your best stands', /Your best stays 02:31/.test(text(s.$('db-post'))), text(s.$('db-post')));
  s.close();
}

{
  console.log('\n— addressed to a player');
  const posts = [];
  const s = await simulator({ kind: 'addressed', player_id: '1-61', name: 'JPEG', pfp_attrs: null }, {
    matrix_sim_post: (a) => { posts.push(a); return { posted: true }; },
  });
  await tick(50);
  const { $ } = s;
  // W2-setup: where the strip lives, and the command bar's keys.
  check('who it is for: a strip right under the Mission header — For, then the name alone', !$('addressed').classList.contains('hidden')
    && text($('for-l')) === 'For' && text($('addressed-name')) === 'JPEG' && $('addressed').closest('#round')
    && $('addressed').previousElementSibling && $('addressed').previousElementSibling.matches('.d-panel-h'));
  check('…Send sits beside the launch keys in the command bar: Send, Play live, Start', $('send-to').parentNode === $('start').parentNode
    && $('start').parentNode.matches('#sim-go > .d-command-r') && $('send-to').nextElementSibling === $('play-live') && $('play-live').nextElementSibling === $('start'));
  check('…Start stays the launch key, Send and Play live violet keys before it', $('start').matches('.d-launch') && $('send-to').matches('.d-btn.is-violet')
    && $('play-live').matches('.d-btn.is-violet.is-lg') && !$('play-live').classList.contains('hidden'));
  check('…and the Share menu holds no live item', !$('share-card').querySelector('#live-to, #live-room, .icon-raid') && !$('live-to') && !$('live-room'));
  check('…and the readiness says who it is for', /for JPEG$/.test(text($('checks').querySelector('.d-ready-d'))));
  check('…and the Send button names them', !$('send-to').classList.contains('hidden') && /Send to\s*JPEG/.test($('send-to').textContent) && $('send-to').title === 'Send to JPEG');
  check('…Play live wears their face and names them; Send to has its own glyph, Post to\'s', $('play-live').contains($('play-live-pfp')) && !$('play-live-pfp').classList.contains('hidden')
    && $('play-live').title === 'Play JPEG live' && /^Play live\s*with JPEG$/.test(text($('play-live'))) && $('send-to').querySelector('i.sui-icon.icon-send-alpha.d-gly') && !$('send-to').querySelector('.d-pf'));
  check('…× says what it stops', $('addressed-clear').getAttribute('aria-label') === 'Stop setting this up for JPEG');
  {
    // fitCommand: jsdom lays nothing out, so whether the readiness word fits is stubbed.
    const head = $('checks').querySelector('.d-ready-h'), bar = $('sim-go');
    const fits = (fn) => { Object.defineProperty(head, 'scrollWidth', { configurable: true, get: fn }); s.sw.dispatchEvent(new s.sw.Event('resize')); };
    Object.defineProperty(head, 'clientWidth', { configurable: true, get: () => 50 });
    fits(() => (bar.classList.contains('s-tight') ? 40 : 80));
    check('a crowded command bar folds the tools, then draws closer — and stops once the word fits', bar.classList.contains('s-fold') && bar.classList.contains('s-tight') && !bar.classList.contains('s-tighter'), bar.className);
    fits(() => 80);
    check('…still crowded, Send to keeps its glyph; no fold hides the readiness — why a start is blocked stays beside the keys', bar.classList.contains('s-tighter')
      && !/#sim-go\.s-[a-z]+[^{,]*\.d-ready/.test(read('frontend/simulator.css')), bar.className);
    fits(() => 10);
    check('…and given room, it unfolds', !['s-fold', 's-tight', 's-tighter'].some((c) => bar.classList.contains(c)), bar.className);
  }
  $('send-to').click();
  await tick(20);
  check('Send posts the battle to them by player id, not by room', posts.length === 1 && posts[0].toPlayer === '1-61' && posts[0].battle && !posts[0].roomId && !posts[0].result);
  // P7: a run addressed to them ends on ONE primary — the strip's Send.
  s.sw.document.body.dataset.screen = 'debrief';
  s.sw.Simulator.social.debrief(JSON.parse(JSON.stringify(config)), result('player', 1, 76, 151));
  await tick(20);
  const go = $('db-post').querySelector('button.d-btn.is-violet');
  check('the debrief offers the send in the alert band, a violet Send key', $('db-post').matches('.d-alert')
    && go && /^Send to JPEG$/.test(text(go)) && go.querySelector('span') && go.querySelector('.icon-outgoing') && $('db-rematch').matches('.d-launch'),
    $('db-post').outerHTML.slice(0, 300));
  s.sw.document.body.dataset.screen = 'setup';
  $('addressed-clear').click();
  check('× makes it a sandbox again', $('addressed').classList.contains('hidden') && $('send-to').classList.contains('hidden')
    && /^Simulator$/.test(text($('sim-mode'))));
  s.close();
}

{
  console.log('\n— the Mission panel and the command bar');
  const s = await simulator(null);
  await tick(50);
  const { sw, $ } = s;
  const st = () => sw.Simulator.getSettings();
  const round = $('round');
  check('Mission is a deck panel, its header named', round.matches('.d-panel') && /^Mission/.test(text(round.querySelector(':scope > .d-panel-h'))));
  const cards = () => [...$('encounters').querySelectorAll('button.d-card')];
  check('Encounter is four cards in a radio group, Difficult pressed', $('encounters').getAttribute('role') === 'radiogroup'
    && $('encounters').getAttribute('aria-labelledby') === 'enc-l' && cards().length === 4 && cards().every((b) => b.getAttribute('role') === 'radio' && b.hasAttribute('aria-checked'))
    && cards().filter((b) => b.getAttribute('aria-checked') === 'true').map((b) => b.dataset.value).join() === 'difficult');
  check('…each with its enemy count', cards().map((b) => text(b.querySelector('.d-card-n'))).join(' ') === '4 8 12 6-16',
    cards().map((b) => text(b.querySelector('.d-card-n'))).join(' '));
  check('no invented option buttons left on the panel', !round.querySelector('.sim-opt, .sim-field-h, #ai-down, #ai-up, select'));
  cards()[3].click();
  const seed1 = $('seed').value;
  cards()[3].click();
  check('Random rolls again on every click, pressed or not', st().preset === 'random' && $('seed').value !== seed1 && cards()[3].getAttribute('aria-checked') === 'true');
  cards()[2].click();
  check('…Hard sets the Opponent with it', st().difficulty === 'hard' && $('ai-level').dataset.value === 'hard');
  const pips = () => [...$('ai-level').querySelectorAll('[role=radio]')];
  check('Opponent is a radio group of three pips', $('ai-level').getAttribute('role') === 'radiogroup' && pips().length === 3
    && pips()[2].getAttribute('aria-checked') === 'true');
  pips().find((p) => p.getAttribute('aria-label') === 'Easy').click();
  check('…and pressing one sets the difficulty', st().difficulty === 'easy' && $('ai-level').dataset.value === 'easy');
  check('Seed sits in a code chip, its dice named', $('seed').closest('.d-code') && $('reseed').closest('.d-code') && $('reseed').getAttribute('aria-label') === 'Roll a new seed');
  const bt = () => [...$('block-time').querySelectorAll('.d-seg-opt')];
  check('Block time is a two-way switch with its notes', bt().length === 2 && text($('block-time')).includes('training') && text($('block-time')).includes('chain')
    && $('block-time').getAttribute('aria-labelledby') === 'bt-l');
  bt()[1].click();
  check('…picking 6 s sets the block time', st().blockMs === 6000 && bt()[1].getAttribute('aria-checked') === 'true' && bt()[0].getAttribute('aria-checked') === 'false');
  check('…and the readiness reads it', /6 s blocks/.test(text($('checks'))), text($('checks')));
  const you = $('charge-player'), cpu = $('charge-cpu');
  check('Opening charge is two batteries, real range inputs to 30', you && cpu && you.matches('input[type=range][max="30"]') && cpu.matches('input[type=range][max="30"]')
    && $('charges').contains(you) && $('charges').contains(cpu) && you.value === '9' && you.getAttribute('aria-label') === 'Your opening charge');
  check('…each says when its first shot is ready', /shot ready/.test(text(you.closest('.d-battery'))) && /shot ready/.test(text(cpu.closest('.d-battery'))));
  you.value = '10'; you.dispatchEvent(new sw.Event('input', { bubbles: true }));
  check('…moving yours sets your charge, the same input kept', st().charge.player === 10 && $('charge-player') === you && you.value === '10');
  cpu.value = '99'; cpu.dispatchEvent(new sw.Event('input', { bubbles: true }));
  check('…a charge past the battery is clamped', st().charge.computer === 30 && cpu.value === '30');
  {
    // W3: the pointer lands on the NEAREST cell (group gaps never put it one
    // off), a drag follows, and the keyboard is the range input's own.
    const cells = [...you.closest('.d-battery').querySelectorAll('.d-cell')];
    cells.forEach((c, i) => { const l = 100 + i * 4 + Math.floor(i / 5) * 2; c.getBoundingClientRect = () => ({ left: l, right: l + 3, width: 3, top: 0, bottom: 5, height: 5 }); });
    const track = you.closest('.d-batt-track');
    const at = (i) => 100 + i * 4 + Math.floor(i / 5) * 2 + 1;
    track.dispatchEvent(new sw.MouseEvent('pointerdown', { bubbles: true, cancelable: true, clientX: at(13) }));
    check('the battery: a press on a cell sets the charge to that cell', st().charge.player === 14 && you.value === '14' && sw.document.activeElement === you, st().charge.player);
    track.dispatchEvent(new sw.MouseEvent('pointermove', { bubbles: true, clientX: at(4) + 2 }));
    track.dispatchEvent(new sw.MouseEvent('pointerup', { bubbles: true, clientX: at(4) + 2 }));
    check('…a drag follows the nearest cell, across a group gap', st().charge.player === 5 && you.value === '5', st().charge.player);
    track.dispatchEvent(new sw.MouseEvent('pointermove', { bubbles: true, clientX: at(20) }));
    check('…and stops with the release', st().charge.player === 5);
    track.dispatchEvent(new sw.MouseEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 90 }));
    track.dispatchEvent(new sw.MouseEvent('pointerup', { bubbles: true, clientX: 90 }));
    check('…left of the first cell is none', st().charge.player === 0);
    you.value = '7'; you.dispatchEvent(new sw.Event('input', { bubbles: true })); you.dispatchEvent(new sw.Event('change', { bubbles: true }));
    check('…the keyboard (the range input) sets it as well, its cells lit to match', st().charge.player === 7
      && you.closest('.d-battery').querySelectorAll('.d-cell.is-lit').length === 7 && you.closest('.d-battery').querySelectorAll('.d-cell.is-head').length === 1);
    you.value = '10'; you.dispatchEvent(new sw.Event('input', { bubbles: true }));
  }
  $('mirror').click();
  check('Mirror copies your charge to the computer\'s battery', st().charge.computer === 10 && cpu.value === '10' && $('charge-cpu') === cpu);
  const share = $('share'), menu = $('share-card');
  check('Share is a menu key; its menu starts closed', share.getAttribute('aria-haspopup') === 'menu' && menu.hidden && menu.getAttribute('role') === 'menu');
  share.click();
  check('…a press opens it: Post to…, Copy link, Paste a battle — and nothing else', !menu.hidden && share.getAttribute('aria-expanded') === 'true'
    && ['post-to', 'export', 'import'].every((id) => menu.contains($(id)) && $(id).getAttribute('role') === 'menuitem')
    && menu.querySelectorAll('.d-menu-item').length === 3 && !menu.querySelector('.d-menu-sep'));
  menu.dispatchEvent(new sw.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  check('…Escape closes it', menu.hidden && share.getAttribute('aria-expanded') === 'false');
  {
    // W3: the keyboard way in and through: ArrowDown opens on the first
    // item, arrows walk the items and wrap, Escape gives focus back to Share.
    const kd = (n, key) => n.dispatchEvent(new sw.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    share.focus();
    kd(share, 'ArrowDown');
    check('Share from the keyboard: ArrowDown opens it on Post to…', !menu.hidden && sw.document.activeElement === $('post-to'));
    kd(menu, 'ArrowDown'); kd(menu, 'ArrowDown');
    check('…arrows walk the items', sw.document.activeElement === $('import'));
    kd(menu, 'ArrowDown');
    check('…skip what is hidden and wrap', sw.document.activeElement === $('post-to'));
    kd(menu, 'End');
    check('…End is the last shown item', sw.document.activeElement === $('import'));
    kd(menu, 'Escape');
    check('…and Escape closes it, focus back on Share', menu.hidden && sw.document.activeElement === share);
  }
  check('the command bar: readiness, the fleets\' tools, the launch', $('sim-go').matches('.d-command') && $('checks').matches('.d-ready') && $('checks').closest('.d-command-l')
    && ['mirror', 'swap', 'share'].every((id) => $(id).matches('button.d-tool') && $(id).closest('.d-command-c'))
    && $('start').matches('button.d-launch') && $('start').closest('.d-command-r') && !$('locked-chip') && $('fleet-head').querySelectorAll('button').length === 0);
  check('…and its second launch, Play live: a violet key as tall as Start, the crossed swords, right before it', $('play-live').matches('button.d-btn.is-violet.is-lg')
    && !$('play-live').classList.contains('hidden') && $('play-live').nextElementSibling === $('start') && text($('play-live')) === 'Play live'
    && $('play-live').querySelector('i.sui-icon.icon-raid.d-gly') && !$('play-live').disabled);
  check('every icon on the Mission panel and the command bar is a deck glyph or sprite', [...round.querySelectorAll('i.sui-icon'), ...$('sim-go').querySelectorAll('i.sui-icon')]
    .every((i) => i.classList.contains('d-gly') || i.classList.contains('d-ico')));
  check('…and every control there is a real button with a name', [...round.querySelectorAll('button'), ...$('sim-go').querySelectorAll('button')]
    .filter((b) => !b.closest('.hidden')).every((b) => b.type === 'button' && (text(b) || b.getAttribute('aria-label'))));
  s.close();
}

{
  console.log('\n— the fleet board and the inspector');
  const s = await simulator(null);
  await tick(50);
  const { sw, $ } = s;
  const doc = sw.document, insp = $('inspector');
  const head = () => text(insp.querySelector(':scope > .d-panel-h'));
  const lay = (id) => sw.Simulator.getLayout().find((u) => u.id === id);
  const slot = (id) => doc.querySelector('#arena .slot[data-unit="' + id + '"]');
  const key = (a) => insp.querySelector('button.d-key[data-ability="' + a + '"]');
  const esc = () => doc.dispatchEvent(new sw.KeyboardEvent('keydown', { key: 'Escape' }));
  check('fleet counts hold the number alone, beside the fleet sprites', /^\d+$/.test(text($('count-you'))) && /^\d+$/.test(text($('count-cpu')))
    && $('count-you').closest('.d-fleet-count').querySelector('i.sui-icon.sui-icon-deployed-structs')
    && $('count-cpu').closest('.d-fleet-count').querySelector('i.sui-icon.sui-icon-enemy-deployed-structs'));
  check('…each fleet\'s reach under its name', $('fleet-head').querySelectorAll('.s-reachrow .d-reach[role=img]').length === 2
    && /^Your fleet reaches/.test($('fleet-head').querySelector('.d-reach').getAttribute('aria-label')));
  check('the board is four ambit bands of deck tiles, 34 slots, 18 structs', $('arena').matches('.d-board') && doc.querySelectorAll('#arena .d-band.band').length === 4
    && doc.querySelectorAll('#arena .d-band > .d-spine').length === 4 && doc.querySelectorAll('#arena .slot.d-tile').length === 34
    && doc.querySelectorAll('#arena .slot[data-unit] .d-ship').length === 18);
  check('no defend banner, no hand-made inspector parts', !$('defend-banner')
    && !doc.querySelector('.sim-name, .sim-weapons, .sim-pick, .sim-opt, .sim-check, .sim-sheet, .sim-types, .sim-insp-h'));
  check('nothing is selected at first: the Inspector column is the Matchup', /^Matchup/.test(head()) && /9 v 9$/.test(head()) && insp.querySelector('.d-stats')
    && !doc.querySelector('#arena .slot.selected'));
  slot('player-cmd').click();
  check('a struct\'s Inspector: where it stands, its name, its health', head() === 'Land · Command' && insp.matches('.d-panel.is-player')
    && text(insp.querySelector('.d-name')) === 'Command Ship' && insp.querySelectorAll('.d-hp.is-lg > .d-hp-s').length === 6 && slot('player-cmd').querySelector('.d-hp'));
  check('…four keys: Move and Guard live, Change and Remove off for the command ship', ['move', 'defend', 'change', 'remove'].every(key)
    && !key('move').disabled && !key('defend').disabled && key('change').disabled && key('remove').disabled && key('defend').title === 'Guard');
  check('…its weapons, reach read from the band it holds', insp.querySelector('.d-weapon .d-reach[aria-label="Hits land"]'),
    [...insp.querySelectorAll('.d-weapon .d-reach')].map((r) => r.getAttribute('aria-label')).join());
  key('move').click();
  check('Move arms a pick: the panel goes amber, the empty command posts become targets', /Pick a band/.test(head()) && insp.matches('.is-warn')
    && doc.querySelectorAll('#arena .slot.sim-move-target').length === 3 && key('move').getAttribute('aria-pressed') === 'true'
    && doc.querySelector('.sim-round-col').inert);
  key('move').click();
  check('…a second press cancels it', head() === 'Land · Command' && !doc.querySelector('#arena .sim-move-target') && !doc.querySelector('.sim-round-col').inert);
  key('move').click();
  doc.querySelector('#arena .band.water .slot.sim-move-target').click();
  check('…and a target moves the command ship there', lay('player-cmd').ambit === 'water' && head() === 'Water · Command' && !doc.querySelector('#arena .sim-move-target'));
  slot('player-space-0').click();
  check('the Battleship: two weapons, and Move off (only a command ship moves)', insp.querySelectorAll('.d-weapon').length === 2 && key('move').disabled && !key('change').disabled);
  const hits = [...doc.querySelectorAll('#arena .slot.enemy.is-target')];
  check('CAN-HIT: every enemy its weapons reach is marked with a reticle, none out of reach', hits.length > 0 && hits.every((b) => b.querySelector('.d-reticle'))
    && slot('computer-cmd').classList.contains('is-target') && !slot('computer-air-0').classList.contains('is-target')
    && !doc.querySelector('#arena .slot.friendly.is-target'));
  slot('computer-space-0').click();
  check('…and both ways: their Battleship marks yours', doc.querySelectorAll('#arena .slot.friendly.is-target').length > 0
    && !doc.querySelector('#arena .slot.enemy.is-target') && insp.matches('.is-enemy'));
  slot('player-space-1').click();
  key('defend').click();
  const mine = sw.Simulator.getLayout().filter((u) => u.side === 'player' && u.id !== 'player-space-1').length;
  check('Guard arms a pick: Pick to guard, amber; your other structs the targets, theirs dimmed', /Pick to guard/.test(head()) && insp.matches('.is-warn')
    && doc.querySelectorAll('#arena .slot.eligible').length === mine && slot('computer-cmd').classList.contains('dim')
    && key('defend').getAttribute('aria-pressed') === 'true' && insp.querySelector('.d-guard.is-picking'));
  esc();
  check('…Escape cancels it', !doc.querySelector('#arena .slot.eligible') && head() === 'Space · Slot 2');
  key('defend').click();
  slot('computer-cmd').click();
  check('…so does pressing anywhere it cannot land', !doc.querySelector('#arena .slot.eligible') && lay('player-space-1').protects === null);
  slot('player-space-1').click();
  insp.querySelector('.d-guard > .d-btn').click();
  check('…the guard row\'s Pick arms it too', doc.querySelectorAll('#arena .slot.eligible').length === mine);
  slot('player-cmd').click();
  check('…a target sets the ward, and the guard row names it', lay('player-space-1').protects === 'player-cmd'
    && /Command Ship/.test(text(insp.querySelector('.d-guard .d-guard-n'))));
  check('…and the board draws the guard line from the selection', doc.querySelector('#arena svg.sim-defweb line.d-guardline')
    && doc.querySelector('#arena svg.sim-defweb rect.d-guardline-end'));
  insp.querySelector('.d-guard .d-iconbtn').click();
  check('…its × clears the guard', lay('player-space-1').protects === null && insp.querySelector('.d-guard.is-empty'));
  key('change').click();
  const cards = () => [...insp.querySelectorAll('button.d-card.is-struct')];
  check('Change opens Deploy: a card per type that fits the band, the current one marked', head() === 'Space · Slot 2' && /Deploy/.test(text(insp.querySelector('.d-sec-h')))
    && cards().length === 3 && cards().every((b) => /^Place a /.test(b.getAttribute('aria-label')) && b.title && b.querySelector('.d-ship'))
    && cards().filter((b) => b.getAttribute('aria-current') === 'true').length === 1);
  check('…the type under the pointer read out below it', insp.querySelector('.s-preview .d-name') && insp.querySelector('.s-preview .d-weapon'));
  esc();
  check('…Escape backs out of it', !insp.querySelector('.d-card.is-struct') && head() === 'Space · Slot 2');
  key('change').click();
  const other = cards().find((b) => b.getAttribute('aria-current') !== 'true');
  other.click();
  check('…a press places that type', sw.SimulatorTypes.types.find((t) => t.id === lay('player-space-1').type).type === other.title && !insp.querySelector('.d-card.is-struct'));
  key('remove').click();
  check('Remove empties the slot, and the empty slot offers Deploy', !lay('player-space-1') && cards().length === 3 && insp.matches('.is-player')
    && doc.querySelector('#arena .band.space .slot.friendly:not([data-unit]) .d-tile-plus') && doc.querySelector('#arena .slot.friendly.s-slot-on:not([data-unit])'));
  insp.querySelector('.d-panel-h button[aria-label="Deselect"]').click();
  check('× Deselect returns to the Matchup', /^Matchup/.test(head()) && !doc.querySelector('#arena .slot.selected, #arena .s-slot-on'));
  sw.Simulator.getLayout().forEach((u) => { u.protects = null; });
  slot('player-cmd').click();
  check('readiness warns, naming what is missing', $('checks').matches('.d-ready.is-warn') && /warning/.test(text($('checks').querySelector('.d-ready-h')))
    && /no defender/.test(text($('checks').querySelector('.d-ready-d')) + ' ' + $('checks').title), $('checks').title);
  check('…and Start stays open (warnings never block)', !$('start').disabled);
  s.close();
}

{
  console.log('\n— the overlays and the debrief (P7)');
  const s = await simulator(null);
  const { sw, $ } = s;
  const doc = sw.document;
  const host = () => sw.Simulator.getHost();
  const esc = () => doc.dispatchEvent(new sw.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  const open = (id) => !$(id).classList.contains('hidden');
  const ctaIds = (ov) => [...ov.querySelectorAll('.d-modal-cta button')].map((b) => b.id).join();
  const p = $('paused');
  const pd = p.querySelector('.d-modal');
  check('Paused is a deck modal on the board layer, a labelled dialog', p.matches('.d-scrim.hidden') && p.parentNode === $('sim-layer')
    && pd && pd.getAttribute('role') === 'dialog' && pd.getAttribute('aria-modal') === 'true'
    && text($(pd.getAttribute('aria-labelledby'))).startsWith('Paused') && p.querySelector('.d-modal-rail .icon-in-progress')
    && /^\d\d:\d\d$/.test(text($('paused-clock'))) && p.contains($('pause-block-time')) && !doc.querySelector('.sim-card, .sim-overlay'));
  check('…its ways out: the forfeit first, the round\'s alternatives, then Resume as the launch key, its chevron after the label',
    ctaIds(p) === 'pause-end,pause-rematch,pause-edit,resume' && $('pause-end').matches('.d-btn.is-coral')
    && $('resume').matches('.d-launch.is-block') && p.querySelectorAll('.d-launch').length === 1
    && $('resume').lastElementChild.matches('i.icon-chevron-right') && $('resume').firstElementChild.matches('span'));
  const d = $('deploy');
  check('Engagement is a deck modal with no CTA, titled Engagement', d.matches('.d-scrim.hidden') && d.parentNode === $('sim-layer')
    && d.querySelector('.d-modal-rail .icon-raid') && /Engagement/.test(text($('deploy-title'))) && $('deploy-title').matches('h2')
    && !d.querySelector('.d-modal-cta').children.length);

  $('start').click();
  await tick(30);
  check('starting deploys: each side its count, roster and opening charge as a readout battery', open('deploy') && text($('deploy-you')) === '9' && text($('deploy-cpu')) === '9'
    && $('deploy-roster-you').querySelectorAll('.d-ship').length === 9 && $('deploy-roster-cpu').querySelectorAll('.d-ship.is-foe').length === 9
    && $('deploy-charge-you').matches('.d-battery.is-readout') && $('deploy-charge-you').querySelectorAll('.d-cell.is-lit').length === 9
    && $('deploy-charge-cpu').matches('.d-battery.is-readout.is-foe.is-mirror'));
  const reachIcons = [...$('deploy-reach-you').querySelectorAll('.d-ico')];
  const reachLabel = $('deploy-reach-you').querySelector('.d-reach').getAttribute('aria-label');
  check('…and its reach: the four ambits, the ones it cannot reach off', reachIcons.length === 4
    && reachIcons.every((i) => i.classList.contains('is-off') === !(/every ambit/.test(reachLabel) || new RegExp(i.className.match(/sui-icon-(space|air|land|water)/)[1]).test(reachLabel))),
    reachLabel);
  check('…the objective: their command ship, enemy-bracketed, where and how strong', $('deploy-target').querySelector('.d-ship.is-foe') && $('deploy-target').querySelector('.d-brackets')
    && /^(Space|Air|Land|Water) · \d+ health/.test(text($('deploy-objective'))) && /^Battle starts in [123]$/.test($('deploy-timer').getAttribute('aria-label')));
  check('…while it counts, Pause and End are disabled in the nav, and the phase reads Deploying', $('end').disabled && $('pause').disabled
    && $('pause').getAttribute('aria-disabled') === 'true' && /Deploying/.test(text($('sim-phase'))));
  for (let i = 0; i < 80 && (open('deploy') || !host().running); i++) await tick(50);
  check('the countdown ends in the battle', !open('deploy') && host().running && !$('end').disabled && /^Block \d+$/.test(text($('sim-phase'))));

  $('end').click();
  await tick(10);
  const confirm = () => $('end-title') && $('end-title').closest('.d-modal');
  check('End asks first: an alert dialog, a forfeit and the standing, Cancel then the coral End battle', confirm() && confirm().getAttribute('role') === 'alertdialog'
    && /Counts as a forfeit · 9\/9 standing/.test(text(confirm())) && confirm().querySelector('.d-modal-rail .icon-attention') && confirm().matches('.is-bad')
    && ctaIds(confirm()) === 'end-cancel,end-confirm' && $('end-confirm').matches('.d-btn.is-coral') && !$('end-cancel').matches('.is-coral'));
  check('…a solo battle holds still while it asks, with no Paused under it', !host().running && !open('paused') && doc.activeElement === $('end-cancel'));
  esc();
  await tick(10);
  check('…Escape cancels and the battle picks up again', !confirm() && host().running && !open('paused'));
  $('pause').click();
  await tick(10);
  check('Pause opens the Paused modal, Resume focused, the nav\'s Pause still there and pressed', open('paused') && doc.activeElement === $('resume') && doc.body.classList.contains('sim-paused')
    && /^\d\d:\d\d$/.test(text($('paused-clock'))) && $('pause').getAttribute('aria-pressed') === 'true' && sw.getComputedStyle($('pause')).display !== 'none'
    && /^Block \d+$/.test(text($('pause-block'))));
  const group = (n) => n && (n.matches('[role="radiogroup"]') ? n : n.querySelector('[role="radiogroup"]'));
  const bt = group($('pause-block-time')), bt0 = group($('block-time'));
  check('…its block time: the two times as a segmented choice of its own', $('pause-block-time').querySelectorAll('.d-seg-opt').length === 2 && bt && bt !== bt0);
  $('pause-end').click();
  await tick(10);
  check('…its End battle asks too, standing in for it', confirm() && !open('paused'));
  $('end-cancel').click();
  await tick(10);
  check('…Cancel gives the pause back, still paused', !confirm() && open('paused') && !host().running);
  esc();
  await tick(10);
  check('…and Escape resumes', !open('paused') && host().running && $('pause').getAttribute('aria-pressed') === 'false');
  $('pause').click();
  await tick(10);
  $('pause').click();
  await tick(10);
  check('…and so does pressing Pause again', !open('paused') && host().running);
  $('end').click();
  await tick(10);
  $('end-confirm').click();
  for (let i = 0; i < 40 && doc.body.dataset.screen !== 'debrief'; i++) await tick(25);
  check('End battle forfeits into the debrief', host().finished && host().finished.forfeit && doc.body.dataset.screen === 'debrief' && !confirm());

  // The debrief (COMMAND DECK, W2-debrief).
  const v = $('verdict');
  check('the verdict: the word in h1#verdict inside the deck\'s defeat frame, the hero tinted to match', text(v) === 'Defeat' && v.matches('h1')
    && v.parentNode.matches('.d-verdict.is-defeat') && $('db-hero').dataset.verdict === 'defeat' && !doc.getElementById('verdict-banner'));
  check('…the meta line in the app\'s words', /^\d\d:\d\d · \d+ blocks? · Difficult · Spearpoint$/.test(text($('debrief-meta'))), text($('debrief-meta')));
  check('…its facts are deck facts, led by the clock and closed by the planet', $('debrief-meta').querySelectorAll(':scope > .d-fact').length === 4
    && $('debrief-meta').querySelector('.d-fact i.icon-in-progress') && $('debrief-meta').querySelector('.d-fact .d-chevs') && $('debrief-meta').querySelector('.d-fact i.icon-planet'));
  const tal = $('tallies').closest('.d-panel');
  check('Tally is a deck panel: its title, the side tags, then one row per tally', tal && /^Tally/.test(text(tal.querySelector('.d-panel-h')))
    && text(doc.querySelector('.sim-tally-h .sim-you')) === 'You' && text(doc.querySelector('.sim-tally-h .sim-cpu')) === 'Computer'
    && $('tallies').querySelectorAll('.d-stat:not(.is-head)').length === 6
    && $('tallies').querySelector('.d-stat i.sui-icon-destroyed') && $('tallies').querySelector('.d-stat i.sui-icon-defender-block') && $('tallies').querySelector('.d-stat i.icon-dmg.is-gold'));
  const fielded = host().summary().fielded['1-1'];
  const chips = [...$('db-chips-you').querySelectorAll('.d-tile')];
  const killed = new Set(host().summary().kills.map((k) => k.struct_id));
  check('Survivors: one static chip per struct you fielded, the destroyed ones dead', chips.length === fielded && chips.every((c) => c.matches('.is-static.is-56'))
    && chips.filter((c) => c.classList.contains('is-dead')).length === host().summary().lost['1-1'] && /^lost \d+ of \d+$/.test(text($('db-lost-you')))
    && $('db-chips-cpu').querySelectorAll('.d-tile.is-foe').length === host().summary().fielded['1-2'] && text($('db-them')) === 'Computer',
    chips.length + '/' + fielded + ' dead ' + chips.filter((c) => c.classList.contains('is-dead')).length + ' kills ' + killed.size);
  const mom = $('moments').closest('.d-panel');
  check('Turning points is a deck panel, with the Full battle log in its footer', mom && /^Turning points/.test(text(mom.querySelector('.d-panel-h'))) && mom.querySelector('.d-panel-f').contains($('show-log'))
    && $('show-log').matches('button.d-tool') && /^\d+ blocks?$/.test(text($('db-blocks'))) && /^\d+ of \d+ attacks?$/.test(text($('db-attacks'))));
  const evs = [...$('moments').querySelectorAll('.d-tl-ev')];
  check('…its events are on the block line, captioned B<n>', evs.length > 0 && evs.length <= 5 && evs.every((e) => /^B\d+$/.test(text(e.querySelector('.d-tl-blk'))) && e.querySelector('.d-ship'))
    || (evs.length === 0 && /No structs destroyed/.test(text($('moments')))), evs.length + ' events');
  check('the next moves: Rematch the launch key, the rest deck keys in the secondary grid, iconed and labelled', $('db-rematch').matches('button.d-launch')
    && ['db-edit', 'db-swap', 'db-harder', 'db-code'].every((id) => $(id).matches('button.d-btn') && $(id).closest('.x-acts .x-sec') && $(id).querySelector('i.sui-icon') && $(id).querySelector('span'))
    && $('db-edit').querySelector('i.icon-edit') && $('db-swap').querySelector('i.icon-transfers') && $('db-code').querySelector('i.icon-outgoing'));
  check('…a defeat at Difficult offers Easier, one step down', text($('db-harder')) === 'Easier' && $('db-harder').querySelector('i.icon-chevron-down') && !$('db-harder').classList.contains('is-coral')
    && !$('db-harder').classList.contains('hidden'), text($('db-harder')));
  check('…New encounter waits for a challenge or a live battle', $('db-new').matches('button.d-btn.hidden') && !doc.querySelector('.sim-link'));
  check('…Share is a menu key', $('db-code').getAttribute('aria-haspopup') === 'menu' && $('db-code').getAttribute('aria-expanded') === 'false');
  $('db-code').click();
  const shareMenu = $($('db-code').getAttribute('aria-controls'));
  check('…which opens on Post to… and Copy link', shareMenu && !shareMenu.hidden && [...shareMenu.querySelectorAll('.d-menu-item')].map((b) => text(b)).join('|') === 'Post to…|Copy link'
    && $('db-code').getAttribute('aria-expanded') === 'true');
  $('db-code').click();
  {
    // W3: TOP STRUCT reads the summary's per-struct tally: yours with the
    // most kills, then the most damage; none without it.
    check('no per-struct kills, no Top struct', $('db-mvp').classList.contains('hidden'));
    const h = host(), plain = h.summary.bind(h);
    h.summary = () => Object.assign(plain(), { byStruct: {
      '5-1002': { owner: '1-1', type: 'Tank', kills: 2, damage: 5 },
      '5-1003': { owner: '1-1', type: 'Battleship', kills: 2, damage: 11 },
      '5-2001': { owner: '1-2', type: 'Cruiser', kills: 6, damage: 30 },
    } });
    sw.Simulator.showDebrief();
    const mvp = $('db-mvp');
    check('…with it: your struct with the most kills, ties broken by damage, never theirs', !mvp.classList.contains('hidden')
      && /^Top struct/.test(text(mvp)) && /Battleship/.test(text(mvp.querySelector('.x-mvp-t'))) && /2 kills · 11 damage/.test(text(mvp))
      && mvp.querySelector('.x-mvp-s .d-ship') && !/Cruiser/.test(text(mvp)), text(mvp));
    h.summary = plain;
    sw.Simulator.showDebrief();
  }
  sw.Simulator.openLink('zzzz');
  await tick(10);
  check('the toast is the deck\'s neutral alert band, words only', $('message').matches('.d-alert.is-neutral') && /does not hold a battle/.test(text($('message').querySelector('.d-alert-d')))
    && !$('message').querySelector('button, .sui-message-system-alert-close-container'));
  s.close();
}

{
  console.log('\n— Post to…');
  const posts = [];
  const s = await simulator(null, {
    matrix_sim_rooms: () => ({ guild_id: '0-5', rooms: [
      { room_id: '!a:h', name: 'SN.Corporation', section: 'local', icon: 'icon-guild' },
      { room_id: '!b:h', name: 'JPEG', section: 'direct', player_id: '1-61', pfp_attrs: null },
    ] }),
    matrix_sim_post: (a) => { posts.push(a); return { posted: true }; },
  });
  const { $ } = s;
  $('post-to').click();
  await tick(30);
  const off = (n) => !!n && (n.disabled === true || n.getAttribute('aria-disabled') === 'true');
  check('the sheet lists the rooms, and picks none for you', $('post-rooms').querySelectorAll('.s-room').length === 2 && off($('post-send')) && !/Post to \S/.test(text($('post-send'))));
  {
    const dlg = $('post-dialog');
    const box = dlg && dlg.querySelector('.d-modal');
    check('…it is a deck dialog, in the scaled layout, named by its title', dlg && dlg.matches('.d-scrim') && $('menu-page-layout').contains(dlg)
      && box && box.matches('.d-modal.is-violet.is-md[role="dialog"][aria-modal="true"]') && /Share battle/.test(text($(box.getAttribute('aria-labelledby'))))
      && dlg.querySelector('.d-modal-rail i.sui-icon.icon-outgoing'));
    const ctas = [...dlg.querySelectorAll('.d-modal-cta > button')];
    check('…Copy link then Post, the teal key last; no close X', ctas.length === 2 && ctas[0].id === 'post-copy' && ctas[0].matches('.d-btn:not(.is-teal)') && ctas[0].querySelector('.icon-copy')
      && ctas[1].id === 'post-send' && ctas[1].matches('.d-btn.is-teal') && text(ctas[1]) === 'Post' && ctas[1].querySelector('.icon-send-alpha') && !dlg.querySelector('.d-iconbtn'));
    check('…the find box is a deck code field, labelled', $('post-find').matches('.d-code > input.d-code-in') && /^Post to$/.test(text(dlg.querySelector('label[for="post-find"]'))));
    const rows = [...$('post-rooms').querySelectorAll('.s-room')];
    check('…the rooms are radio rows, each marked as Comms marks a room', $('post-rooms').matches('[role="radiogroup"]')
      && rows.every((r) => r.matches('label.s-room') && r.querySelector('input.d-sr[type="radio"][name="post-room"]'))
      && rows[0].querySelector('.chat-room-icon i.icon-guild') && rows[1].querySelector('.pfp-frame')
      && /PID #1-61/.test(text(rows[1])) && !/direct|channel/.test(text($('post-rooms'))));
  }
  $('post-find').value = 'jp';
  $('post-find').dispatchEvent(new s.sw.Event('input'));
  check('…typing narrows it', $('post-rooms').querySelectorAll('.s-room').length === 1);
  $('post-find').value = '1-6';
  $('post-find').dispatchEvent(new s.sw.Event('input'));
  check('…a player id only whole: 1-6 is not 1-61', /No room by that name/.test(text($('post-rooms'))), text($('post-rooms')));
  $('post-find').value = '1-61';
  $('post-find').dispatchEvent(new s.sw.Event('input'));
  check('…and 1-61 finds their DM', $('post-rooms').querySelectorAll('.s-room').length === 1 && text($('post-rooms').querySelector('.s-room-n')) === 'JPEG');
  $('post-rooms').querySelector('.s-room').click();
  check('…a click anywhere on the row picks it, and Post wakes', $('post-rooms').querySelector('input[name="post-room"]').checked && !off($('post-send')) && /^Post to /.test(text($('post-send'))));
  $('post-send').click();
  await tick(20);
  check('…and Post sends the battle code to that room, nothing else', posts.length === 1 && posts[0].roomId === '!b:h' && posts[0].guildId === '0-5' && posts[0].battle && posts[0].result == null);
  check('…then closes', !s.$('post-dialog'));
  $('import').click();
  check('Paste is the same deck dialog: a Battle link field, Cancel and Load battle', $('code-dialog') && $('code-dialog').matches('.d-scrim') && $('layout-code').matches('.d-code > input.d-code-in')
    && /^Battle link$/.test(text($('code-dialog').querySelector('label[for="layout-code"]'))) && text($('code-load')) === 'Load battle' && $('code-load').matches('.d-btn.is-teal')
    && /^Cancel$/.test(text($('code-dialog').querySelector('.d-modal-cta > button'))) && $('code-dialog').querySelector('.d-modal-rail .icon-incoming')
    && s.sw.document.activeElement === $('layout-code'));
  $('layout-code').value = 'nonsense';
  $('layout-code').dispatchEvent(new s.sw.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  check('…Enter loads, and a bad link says why while the dialog stays', $('code-dialog') && /link|battle/i.test(text($('message'))), text($('message')));
  s.sw.document.dispatchEvent(new s.sw.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  check('…Escape closes it', !$('code-dialog'));
  s.close();
}

{
  console.log('\n— Play live');
  const opened = [];
  let failNext = false;
  const rooms = [
    { room_id: '!a:h', name: 'SN.Corporation', section: 'local', icon: 'icon-guild', members: 25 },
    { room_id: '!b:h', name: 'JPEG', section: 'direct', player_id: '1-61', pfp_attrs: null },
    { room_id: '!w:h', name: 'War Room', section: 'local', icon: 'icon-raid', members: 6 },
    { room_id: '!c:h', name: 'T.Xue', section: 'direct', player_id: '1-9', pfp_attrs: null },
  ];
  const s = await simulator(null, {
    matrix_sim_rooms: () => ({ guild_id: '0-5', rooms }),
    matrix_sim_live_open: (a) => {
      opened.push(a);
      if (failNext) { failNext = false; throw new Error('that player has no comms account'); }
      return { guild_id: '0-5', room_id: a.roomId, match_room: a.roomId, invite_event: '$inv', me: '@1-1:h', block_ms: 4000, guest: { user_id: '@1-61:h', name: 'JPEG' } };
    },
    matrix_person: (a) => ({ user_id: a.userId, name: 'Marklifer', pfp_attrs: null, player_id: '1-1' }),
    matrix_timeline: () => ({ messages: [] }),
  });
  const { sw, $ } = s;
  const off = (n) => !!n && (n.disabled === true || n.getAttribute('aria-disabled') === 'true');
  const names = () => [...$('live-rooms').querySelectorAll('.s-room .s-room-n')].map(text);
  const type = (v) => { $('live-find').value = v; $('live-find').dispatchEvent(new sw.Event('input')); };
  check('the sandbox shows Play live beside Start', !$('play-live').classList.contains('hidden') && $('play-live').nextElementSibling === $('start'));
  {
    // Both launches wait on the same fleets: no computer command ship, no start of either kind.
    const d = sw.Simulator.getLayout(), i = d.findIndex((u) => u.id === 'computer-cmd'), cmd = d.splice(i, 1)[0];
    // A charge change re-reads the fleets (the battery only answers a new value).
    const recheck = (v) => { $('charge-player').value = v; $('charge-player').dispatchEvent(new sw.Event('input', { bubbles: true })); };
    recheck('8');
    check('a battle that cannot start cannot be played live either', $('start').disabled && $('play-live').disabled && /Can.t start/.test(text($('checks'))), text($('checks')));
    d.splice(i, 0, cmd);
    recheck('9');
    check('…and fleets put right wake both', !$('start').disabled && !$('play-live').disabled, text($('checks')));
  }
  $('play-live').click();
  await tick(30);
  {
    const dlg = $('live-dialog');
    const box = dlg && dlg.querySelector('.d-modal');
    check('it opens a deck dialog like Post to…: in the scaled layout, titled Play live, the crossed swords on its rail', dlg && dlg.matches('.d-scrim') && $('menu-page-layout').contains(dlg)
      && box && box.matches('.d-modal.is-violet.is-md[role="dialog"][aria-modal="true"]') && /^Play live$/.test(text($(box.getAttribute('aria-labelledby'))))
      && dlg.querySelector('.d-modal-rail i.sui-icon.icon-raid'));
    check('…what will be played: the battle, its fleets (no computer level: a person plays it), 4 s blocks', /^Spearpoint · 9 v 9 · 4 s blocks$/.test(text($('live-what'))), text($('live-what')));
    check('…a find field, the deck\'s code field, labelled', $('live-find').matches('.d-code > input.d-code-in') && $('live-find').placeholder === 'Find a player or room'
      && /^Invite$/.test(text(dlg.querySelector('label[for="live-find"]'))) && sw.document.activeElement === $('live-find'));
    const ctas = [...dlg.querySelectorAll('.d-modal-cta > button')];
    check('…one key: Invite, teal, the crossed swords', ctas.length === 1 && ctas[0] === $('live-send') && $('live-send').matches('.d-btn.is-teal') && $('live-send').querySelector('.icon-raid'));
  }
  check('…your DMs first, then the rooms as given — Post to\'s rows', names().join() === 'JPEG,T.Xue,SN.Corporation,War Room'
    && $('live-rooms').matches('[role="radiogroup"]') && [...$('live-rooms').querySelectorAll('.s-room')].every((r) => r.matches('label.s-room') && r.querySelector('input.d-sr[type="radio"]'))
    && $('live-rooms').querySelectorAll('.s-room .pfp-frame').length === 2 && /PID #1-61/.test(text($('live-rooms').querySelector('.s-room'))), names().join());
  check('…nothing picked for you: Invite waits', !$('live-rooms').querySelector('input:checked') && off($('live-send')) && text($('live-send')) === 'Invite');
  sw.document.dispatchEvent(new sw.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  check('…Escape closes it', !$('live-dialog'));
  $('play-live').click();
  await tick(30);
  type('1-999');
  const rowNew = $('live-rooms').querySelector('.s-room');
  check('a player id typed in, with no DM yet, is a row of its own', names().join() === 'Player 1-999' && rowNew.querySelector('.chat-room-icon i.icon-member'));
  rowNew.click();
  check('…picked, Invite names them', !off($('live-send')) && text($('live-send')) === 'Invite Player 1-999');
  failNext = true;
  $('live-send').click();
  await tick(30);
  check('…Invite opens a match for that player, by id', opened.length === 1 && opened[0].toPlayer === '1-999' && !opened[0].roomId && opened[0].guildId === '0-5' && opened[0].battle && opened[0].blockMs === 4000);
  check('…and when it fails, the dialog stays, Invite wakes, and the reason is said', $('live-dialog') && !off($('live-send')) && /Not opened — that player has no comms account/.test(text($('message'))), text($('message')));
  type('1-61');
  check('a player id with a DM finds the DM, not a second row', names().join() === 'JPEG');
  type('1-6');
  check('…an id only whole: 1-6 is a player of its own, never 1-61', names().join() === 'Player 1-6', names().join());
  type('');
  check('…clearing the field brings the list back, the pick kept only if shown', names().length === 4 && off($('live-send')));
  $('live-rooms').querySelectorAll('.s-room')[2].click();
  check('a room: Open in it — anyone there may take it', text($('live-send')) === 'Open in SN.Corporation' && /Anyone in SN\.Corporation/.test($('live-send').title));
  $('live-rooms').querySelectorAll('.s-room')[0].click();
  check('a DM: Invite them', text($('live-send')) === 'Invite JPEG');
  $('live-send').click();
  check('…the key holds while it opens', off($('live-send')));
  await tick(40);
  check('…the match opens in that DM, in that guild', opened.length === 2 && opened[1].roomId === '!b:h' && opened[1].guildId === '0-5' && !opened[1].toPlayer);
  check('…the dialog closes and the lobby is the board: Start reads Ready, Play live is gone', !$('live-dialog') && text($('start')) === 'Ready'
    && /Live battle/.test(text($('challenge'))) && $('play-live').classList.contains('hidden'));
  s.close();
}

{
  console.log('\n— Play live from a challenge, and signed out');
  const opened = [];
  const s = await simulator({ kind: 'challenge', guild_id: '0-1', room_id: '!r:h', event_id: '$root', battle }, {
    matrix_sim_thread: () => ({ me, frame, room_name: 'SN.Corporation', ladder: [] }),
    // Rooms that each name their guild, and none at the top.
    matrix_sim_rooms: () => ({ rooms: [{ guild_id: '0-1', room_id: '!x:h', name: 'War Room', section: 'local' }, { guild_id: '0-1', room_id: '!r:h', name: 'SN.Corporation', section: 'local' }] }),
    matrix_sim_live_open: (a) => { opened.push(a); return { guild_id: '0-1', room_id: a.roomId, match_room: '!m:h', invite_event: '$inv', me: '@1-1:h', block_ms: 4000, guest: null }; },
    matrix_person: (a) => ({ user_id: a.userId, name: 'Marklifer', pfp_attrs: null, player_id: '1-1' }),
    matrix_timeline: () => ({ messages: [] }),
  });
  await tick(30);
  const { $ } = s;
  check('a challenge shows Play live beside Start', !$('play-live').classList.contains('hidden'));
  $('play-live').click();
  await tick(30);
  check('…its picker has the challenge\'s own room picked, first and once', $('live-rooms').querySelector('input:checked') && $('live-rooms').querySelector('input:checked').value === '!r:h'
    && $('live-rooms').querySelector('.s-room input').value === '!r:h' && $('live-rooms').querySelectorAll('.s-room').length === 2
    && text($('live-send')) === 'Open in SN.Corporation' && !$('live-send').disabled && /^Spearpoint · /.test(text($('live-what'))));
  $('live-send').click();
  await tick(40);
  check('…opened there, in the room\'s own guild', opened.length === 1 && opened[0].roomId === '!r:h' && opened[0].guildId === '0-1' && !$('live-dialog'));
  s.close();

  // Edited, the fleets are no longer the challenge: nothing is picked for you.
  const e = await simulator({ kind: 'challenge', guild_id: '0-1', room_id: '!r:h', event_id: '$root', battle }, {
    matrix_sim_thread: () => ({ me, frame, room_name: 'SN.Corporation', ladder: [] }),
    matrix_sim_rooms: () => ({ guild_id: '0-1', rooms: [{ room_id: '!r:h', name: 'SN.Corporation', section: 'local' }] }),
  });
  await tick(30);
  e.$('unlock').click();
  await tick(20);
  e.$('play-live').click();
  await tick(30);
  check('an edited challenge picks nothing: its room is no longer its battle\'s', !e.$('live-rooms').querySelector('input:checked') && e.$('live-send').disabled && text(e.$('live-send')) === 'Invite');
  e.close();

  // A challenge an identity's Comms window opened: its room is that session's,
  // which the primary's list need not hold — still first, picked, and opened as it.
  const idOpened = [];
  const id = await simulator({ kind: 'challenge', guild_id: '0-5#1-271', room_id: '!id:h', event_id: '$root', battle }, {
    matrix_sim_thread: () => ({ me, frame, room_name: 'Fleet Yard', ladder: [] }),
    matrix_sim_rooms: () => ({ guild_id: '0-5', rooms: [{ room_id: '!a:h', name: 'SN.Corporation', section: 'local' }] }),
    matrix_sim_live_open: (a) => { idOpened.push(a); return { guild_id: a.guildId, room_id: a.roomId, match_room: '!m:h', invite_event: '$inv', me: '@1-271:h', block_ms: 4000, guest: null }; },
  });
  await tick(30);
  id.$('play-live').click();
  await tick(30);
  check('a challenge from another Comms session: its own room is first and picked', [...id.$('live-rooms').querySelectorAll('.s-room .s-room-n')].map(text).join() === 'Fleet Yard,SN.Corporation'
    && id.$('live-rooms').querySelector('input:checked') && id.$('live-rooms').querySelector('input:checked').value === '!id:h' && text(id.$('live-send')) === 'Open in Fleet Yard');
  id.$('live-send').click();
  await tick(30);
  check('…and opens in that session, not the primary', idOpened.length === 1 && idOpened[0].guildId === '0-5#1-271' && idOpened[0].roomId === '!id:h');
  id.close();

  const t = await simulator({ kind: 'addressed', player_id: '1-61', name: 'JPEG-the-long', pfp_attrs: null }, {
    matrix_sim_rooms: () => ({ guild_id: '0-1', rooms: [{ room_id: '!g:h', name: 'Galaxy', section: 'galaxy' }, { room_id: '!b:h', name: 'JPEG', section: 'direct', player_id: '1-61', pfp_attrs: null }] }),
  });
  t.$('play-live').click();
  await tick(30);
  check('addressed, with a DM: the DM is picked, and the key reads Invite JPEG', t.$('live-rooms').querySelector('input:checked') && t.$('live-rooms').querySelector('input:checked').value === '!b:h'
    && text(t.$('live-send')) === 'Invite JPEG' && !t.$('live-send').disabled && t.$('live-rooms').querySelectorAll('.s-room').length === 2);
  t.close();

  const u = await simulator(null, { matrix_sim_rooms: () => { throw new Error('no guild you belong to runs a comms server'); } });
  u.$('play-live').click();
  await tick(30);
  check('signed out of Comms: the list says why, and Invite stays off', /no guild you belong to runs a comms server/.test(text(u.$('live-rooms'))) && u.$('live-send').disabled);
  u.$('live-find').value = '1-999';
  u.$('live-find').dispatchEvent(new u.sw.Event('input'));
  check('…typing changes nothing until there is a list', /no guild you belong to/.test(text(u.$('live-rooms'))) && u.$('live-send').disabled);
  u.close();

  const g = await simulator({ kind: 'live', role: 'guest', guild_id: '0-1', room_id: '!dm:h', invite_event: '$inv', match_room: '!dm:h',
    battle, block_ms: 4000, host: '@1-61:h', host_name: 'JPEG', host_pfp: null, me: '@1-1:h' }, { matrix_timeline: () => ({ messages: [] }) });
  await tick(30);
  check('a live lobby has no Play live: it is one already', g.$('play-live').classList.contains('hidden') && /^Ready/.test(text(g.$('start'))));
  g.close();
}

{
  console.log('\n— Play live: one invite at a time, and what arrives while it is open');
  const opened = [];
  let answer = null, gate = null;
  const rooms = [{ room_id: '!b:h', name: 'JPEG', section: 'direct', player_id: '1-61', pfp_attrs: null }, { room_id: '!c:h', name: 'T.Xue', section: 'direct', player_id: '1-9', pfp_attrs: null }];
  const answers = {
    matrix_sim_rooms: () => (gate || Promise.resolve()).then(() => ({ guild_id: '0-5', rooms })),
    // The reply waits for the test: answer(true) opens, answer(false) refuses.
    matrix_sim_live_open: (a) => { opened.push(a); return new Promise((ok, no) => { answer = (yes) => (yes ? ok({ guild_id: '0-5', room_id: a.roomId, match_room: a.roomId, invite_event: '$inv', me: '@1-1:h', block_ms: 4000, guest: { user_id: '@1-61:h', name: 'JPEG' } }) : no(new Error('the homeserver is busy'))); }); },
  };
  const s = await simulator(null, answers);
  const { sw, $ } = s;
  const pick = (name) => [...$('live-rooms').querySelectorAll('.s-room')].find((r) => text(r.querySelector('.s-room-n')) === name).click();
  const esc = () => sw.document.dispatchEvent(new sw.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  $('play-live').click();
  await tick(30);
  pick('JPEG');
  $('live-send').click();
  await tick(10);
  esc();
  $('play-live').click();
  await tick(30);
  pick('JPEG');
  check('closed and reopened while an invite opens: Invite holds until it answers', $('live-dialog') && $('live-send').disabled && opened.length === 1);
  $('live-send').click();
  await tick(10);
  check('…a press there opens nothing more', opened.length === 1);
  answer(false);
  await tick(20);
  check('…refused: the open picker wakes, the reason said', $('live-dialog') && !$('live-send').disabled && /Not opened — the homeserver is busy/.test(text($('message'))), text($('message')));
  $('live-send').click();
  await tick(10);
  answer(true);
  await tick(30);
  check('…opened: the lobby takes the board, no picker', opened.length === 2 && !$('live-dialog') && $('play-live').classList.contains('hidden'));
  s.close();

  const t = await simulator(null, answers);
  t.$('play-live').click();
  await tick(30);
  t.setPending({ kind: 'addressed', player_id: '1-9', name: 'T.Xue', pfp_attrs: null });
  await t.sw.Simulator.takeContext();
  await tick(30);
  check('a player handed over from Comms while the picker is open closes it: it named the old battle', !t.$('live-dialog') && /^T\.Xue$/.test(text(t.$('addressed-name'))));
  t.$('play-live').click();
  await tick(30);
  check('…opened again, their DM is picked', t.$('live-rooms').querySelector('input:checked') && t.$('live-rooms').querySelector('input:checked').value === '!c:h' && text(t.$('live-send')) === 'Invite T.Xue');
  t.setPending({ kind: 'live', role: 'guest', guild_id: '0-1', room_id: '!dm:h', invite_event: '$inv', match_room: '!dm:h',
    battle, block_ms: 4000, host: '@1-61:h', host_name: 'JPEG', host_pfp: null, me: '@1-1:h' });
  await t.sw.Simulator.takeContext();
  await tick(30);
  check('…a live battle arriving closes it too, and hides Play live', !t.$('live-dialog') && t.$('play-live').classList.contains('hidden'));
  t.close();

  // A slow rooms answer reaches only the picker that is open.
  let release;
  gate = new Promise((r) => { release = r; });
  const u = await simulator(null, answers);
  u.$('play-live').click();
  await tick(10);
  u.sw.document.dispatchEvent(new u.sw.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  u.$('play-live').click();
  await tick(10);
  release();
  await tick(30);
  check('a rooms answer that comes late lists once, in the open picker, picking nothing', u.$('live-rooms').querySelectorAll('.s-room').length === 2 && u.$('live-send').disabled);
  u.close();
  gate = null;
}

{
  console.log('\n— a new battle handed over during a live one');
  const frames = [], statuses = [];
  const s = await simulator({ kind: 'live', role: 'host', guild_id: '0-1', room_id: '!dm:h', invite_event: '$inv', match_room: '!dm:h',
    battle, block_ms: 4000, host: '@1-1:h', host_name: 'You', me: '@1-1:h', expect: { user_id: '@1-61:h', name: 'JPEG' } }, {
    matrix_sim_live_send: (a) => { frames.push(a.frame); return { event_id: '$x' }; },
    matrix_sim_live_status: (a) => { statuses.push(a.frame); return { event_id: '$s' }; },
    matrix_timeline: () => ({ messages: [] }),
  });
  await tick(30);
  check('the host waits in a DM lobby', /Live battle/.test(text(s.$('challenge'))));
  s.setPending({ kind: 'addressed', player_id: '1-9', name: 'T.Xue', pfp_attrs: null });
  await s.sw.Simulator.takeContext();
  await tick(30);
  check('Comms\' Challenge to a battle leaves it as Leave would: the guest hears it, the invite is withdrawn', frames.some((f) => f.kind === 'leave' && f.forfeit === false)
    && statuses.some((f) => f.state === 'cancelled') && /^T\.Xue$/.test(text(s.$('addressed-name'))) && !s.$('play-live').classList.contains('hidden'));
  s.close();
}

/* ── 5. Live: the host's board, replayed on the other side ─────────────── */
{
  console.log('\n— live: ticks and moves');
  const ldom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' });
  const lw = ldom.window;
  for (const f of ['simulator-types.js', 'simulator-chain.js', 'simulator-host.js', 'simulator-live.js']) lw.eval(read('frontend/' + f));
  const T = Object.fromEntries(lw.SimulatorTypes.types.map((t) => [t.type, t.id]));
  const S = (id, name, owner, ambit, slot = 0) => ({ id, typeId: T[name], owner, ambit, slot, protects: null });
  const chain = new lw.SimulatorChain({ types: lw.SimulatorTypes.types, seed: 'live', height: 500,
    players: [{ id: '1-1', fleetId: '9-1', charge: 20 }, { id: '1-2', fleetId: '9-2', charge: 20 }],
    structs: [S('5-1', 'Command Ship', '1-1', 'space'), S('5-2', 'Battleship', '1-1', 'space'), S('5-3', 'Command Ship', '1-2', 'space'), S('5-4', 'Starfighter', '1-2', 'space')] });
  const host = new lw.SimulatorHost({ chain, you: { id: '1-1', name: 'You' }, cpu: { id: '1-2', name: 'JPEG', label: 'JPEG’s fleet' }, label: 'sim', blockMs: 6000, ai: null, frame: () => null });
  const sent = [];
  const link = lw.SimLive.HostLink(host, (f) => sent.push(f));
  host.start();
  host.block();
  const tick = sent.filter((f) => f.kind === 'tick').pop();
  const snap = tick && tick.events.find((e) => e[0] === 'raid-snapshot');
  check('a block goes out as one tick of the board\'s own events', tick && tick.v === 1 && typeof tick.block === 'number' && tick.events.some((e) => e[0] === 'raid-block'));
  check('…its snapshot without the struct type encyclopedia', snap && snap[1].snapshot && !snap[1].snapshot.struct_types && snap[1].snapshot.structs.length === 4);
  check('…and no computer: the host runs with nobody deciding for the other fleet', host.ai === null && host.cpu.label === 'JPEG’s fleet');

  const types = Object.fromEntries(lw.SimulatorTypes.types.map((t) => [t.id, lw.SimulatorHost.spectatorType(t)]));
  const moves = [];
  const posted = [];
  const guest = new lw.SimLive.RemoteHost({ role: 'guest', label: 'sim', types, initial: host.snapshot(), frame: () => ({ postMessage: (m) => posted.push(m) }),
    players: { host: { name: 'Marklifer' }, guest: { name: 'JPEG' } }, send: (f) => moves.push(f) });
  guest.tick(tick);
  const seen = await guest.invoke('mcp_raid_state', {});
  const mine = seen.snapshot.structs.filter((s) => s.owner === '1-2');
  check('the guest sees its own fleet on the left, as "Your fleet"', mine.length === 2 && mine.every((s) => s.side === 'defender') && seen.snapshot.owner === '1-2' && seen.snapshot.owner_label === 'Your fleet');
  check('…struct types filled from its own catalogue', Object.keys(seen.snapshot.struct_types).length >= 3);
  check('…the ticks replayed into its board as events', posted.some((m) => m.kind === 'event' && /^raid-block::sim$/.test(m.name)));
  const roster = await guest.invoke('mcp_roster', {});
  check('…and it controls the guest\'s fleet only', roster.rows.length === 1 && roster.rows[0].player_id === '1-2');
  check('standing and fielded read "you" as the guest', guest.standing()['1-1'] === 2 && guest.fielded['1-1'] === 2);

  const said = await guest.invoke('mcp_struct_act', { player: '1-2', action: 'attack', args: { attacker_id: '5-3', target_id: '5-2', weapon: 'primary' } });
  check('a guest\'s action leaves as a move frame', moves.length === 1 && moves[0].kind === 'move' && moves[0].action === 'attack' && /submitted/.test(said));
  let refused = null;
  try { await guest.invoke('mcp_struct_act', { player: '1-1', action: 'attack', args: {} }); } catch (e) { refused = String(e.message || e); }
  check('…and only for the guest\'s own fleet', /no key/.test(refused || ''));
  link.move(moves[0]);
  const before = chain.structs['5-2'].health;
  host.block();
  const hit = chain.structs['5-2'].health < before || chain.lastBlock === undefined;
  check('the host applies it as the guest\'s transaction in the next block', hit, 'health ' + before + ' → ' + chain.structs['5-2'].health);

  host.forfeit();
  const end = { v: 1, kind: 'end', winner: 'guest', forfeit: true, summary: host.summary() };
  guest.end(end);
  const sum = guest.summary();
  check('the host giving up is the guest\'s victory, in the guest\'s terms', guest.finished.winner === 'you' && guest.finished.forfeit && sum.fielded['1-1'] === 2);

  /* A rate-limited homeserver: one send in flight, blocks merge behind it. */
  {
    const chain2 = new lw.SimulatorChain({ types: lw.SimulatorTypes.types, seed: 'slow', height: 500,
      players: [{ id: '1-1', fleetId: '9-1', charge: 20 }, { id: '1-2', fleetId: '9-2', charge: 20 }],
      structs: [S('5-1', 'Command Ship', '1-1', 'space'), S('5-3', 'Command Ship', '1-2', 'space')] });
    const host2 = new lw.SimulatorHost({ chain: chain2, you: { id: '1-1', name: 'You' }, cpu: { id: '1-2', name: 'JPEG' }, label: 'sim', blockMs: 4000, ai: null, frame: () => null });
    const out = [], waiting = [];
    const settle = () => new Promise((r) => setTimeout(r, 0));
    const link2 = lw.SimLive.HostLink(host2, (f) => { out.push(f); return new lw.Promise((res) => waiting.push(res)); });
    host2.start();
    host2.block(); host2.block(); host2.block();
    check('while a tick waits on the homeserver, later blocks hold back', out.length === 1, out.length + ' sent');
    link2.after({ v: 1, kind: 'end', winner: 'draw' });
    waiting.shift()();
    await settle();
    const merged = out[1];
    check('…then leave as ONE tick carrying every block they missed', out.length === 2 && merged.kind === 'tick' && merged.events.filter((e) => e[0] === 'raid-block').length === 3);
    check('…and the end waits behind them', out.length === 2);
    waiting.shift()();
    await settle();
    check('…going out last, once the ticks before it have', out.length === 3 && out[2].kind === 'end');
  }
  const watcher = new lw.SimLive.RemoteHost({ role: 'watch', label: 'sim', types, initial: host.snapshot(), frame: () => null, players: { host: { name: 'Marklifer' }, guest: { name: 'JPEG' } }, send: () => { throw new Error('a watcher sends nothing'); } });
  watcher.end(end);
  let wrefused = null;
  try { await watcher.invoke('mcp_struct_act', { player: '1-2', action: 'attack', args: {} }); } catch (e) { wrefused = String(e.message || e); }
  check('a watcher sees it from the host\'s side and cannot act', watcher.finished.winner === 'cpu' && /watching/.test(wrefused || '') && (await watcher.invoke('mcp_roster', {})).rows.length === 0);
  host.destroy(); guest.destroy(); watcher.destroy();
}

{
  console.log('\n— live: the guest\'s simulator');
  const frames = [];
  // A real match runs at 4 s, which no battle link can hold; uneven charge
  // tells the host's side of the battle from the guest's.
  const lopsided = Code.encode(Object.assign({}, config, { charge: { player: 9, computer: 6 } }));
  const s = await simulator({ kind: 'live', role: 'guest', guild_id: '0-1', room_id: '!r:h', invite_event: '$inv', match_room: '!m:h', battle: lopsided, block_ms: 4000,
    host: '@1-61:h', host_name: 'JPEG', host_pfp: null, me: '@1-1:h' }, {
    matrix_sim_live_send: (a) => { frames.push(a.frame); return { event_id: '$x' }; },
    matrix_timeline: () => ({ messages: [{ event_id: '$c1', sender: '@1-61:h', sender_name: 'JPEG', kind: 'text', body: 'gl', ts: 1 }] }),
  });
  await tick(50);
  const { $, subs } = s;
  const fire = (frame, sender = '@1-61:h') => (subs['matrix::sim'] || []).forEach((cb) => cb({ payload: { room_id: '!m:h', sender, frame } }));
  check('joining says hello to the host', frames.some((f) => f.kind === 'hello'));
  check('the lobby: Live battle panel, both seats, the match chat', /Live battle/.test(text($('challenge'))) && /JPEG/.test(text($('challenge'))) && /You/.test(text($('challenge'))) && /gl/.test(text($('challenge'))));
  check('…a deck panel in the enemy tone, the talk as deck messages, a composer in its footer', $('challenge').matches('.d-panel.is-enemy:not(.is-warn)')
    && /^Live battle$/.test(text($('challenge').querySelector('.d-panel-h'))) && /JPEG/.test(text($('challenge').querySelector('.d-msg.is-foe .d-msg-h')))
    && $('challenge').querySelector('.d-panel-f .d-composer input#match-say') && $('challenge').querySelector('.d-panel-f .d-composer button.d-btn.is-teal[aria-label="Send"] .icon-send-alpha')
    && $('unlock').classList.contains('hidden'));
  check('…the top bar\'s mode is Live with the host\'s face', $('sim-mode').matches('.d-mode.is-live') && /^Live · JPEG$/.test(text($('sim-mode'))) && $('sim-mode').querySelector('.d-pf'));
  check('…fleets fixed, and the launch key says Ready', $('round').classList.contains('hidden') && /^Ready/.test(text($('start').querySelector('span'))) && $('mirror').disabled && $('swap').disabled);
  $('match-say').value = 'gl hf';
  $('match-say').dispatchEvent(new s.sw.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await tick(20);
  const said = s.calls.filter((c) => c[0] === 'matrix_send')[0];
  check('…what is typed there goes to the match room', said && said[1].roomId === '!m:h' && said[1].body === 'gl hf' && $('match-say').value === '');
  $('start').click();
  await tick(20);
  check('Ready tells the host', frames.some((f) => f.kind === 'ready' && f.ready === true) && /waiting/i.test(text($('start'))), JSON.stringify(frames) + ' | ' + text($('start')) + ' | disabled=' + $('start').disabled);
  fire({ v: 1, kind: 'ready', ready: true }, '@1-99:h');
  const hostSeat = () => text($('challenge').querySelector('.sim-run'));
  check('…a frame from anyone but the host is ignored', /JPEG/.test(hostSeat()) && !/Ready/.test(hostSeat()), hostSeat());
  check('…a seat not ready says so as an amber pill, and the lobby is the phase pill', $('challenge').querySelector('.sim-seat .d-pill.is-amber')
    && /Not ready/.test(text($('challenge').querySelector('.sim-run .d-pill'))) && /^Lobby$/.test(text($('challenge').querySelector('.s-pills .s-phase'))));
  fire({ v: 1, kind: 'ready', ready: true });
  check('…the host\'s own ready shows on its seat', /Ready/.test(hostSeat()), hostSeat());
  fire({ v: 1, kind: 'start', battle: lopsided, block_ms: 4000 });
  await tick(30);
  check('the host\'s start begins the battle here, the board replaying its ticks', s.sw.document.body.dataset.screen === 'battle' && s.sw.Simulator.getHost() instanceof s.sw.SimLive.RemoteHost);
  check('…with the Live pill (coral, its LED lit), and no pause for a battle between two', /Live/.test(text($('sim-status')))
    && $('sim-status').querySelector('.d-pill.is-coral > .d-led.is-coral') && $('sim-phase') && s.sw.getComputedStyle($('pause')).display === 'none');
  {
    const rh = s.sw.Simulator.getHost();
    let ticks = 0;
    const orig = rh.tick.bind(rh);
    rh.tick = (f) => { ticks++; orig(f); };
    const t7 = { v: 1, kind: 'tick', block: 501, events: [], sid: 'h1', seq: 7 };
    fire(t7); fire(Object.assign({}, t7));
    check('a tick that arrives both ways (direct and the room) is replayed once', ticks === 1, ticks + ' replays');
    fire({ v: 1, kind: 'tick', block: 500, events: [], sid: 'h1', seq: 6 });
    check('…and one older than the board shows is not replayed at all', ticks === 1);
    check('every frame this side sends carries its session and sequence', frames.length > 0 && frames.every((f) => typeof f.sid === 'string' && typeof f.seq === 'number'));
  }
  s.sw.Simulator.getHost().end({ v: 1, kind: 'end', winner: 'guest', summary: { stats: {}, lost: { '1-1': 4, '1-2': 1 }, fielded: { '1-1': 9, '1-2': 9 }, kills: [] } });
  await tick(2700);
  check('the host\'s end is the debrief: you beat them', s.sw.document.body.dataset.screen === 'debrief' && /You beat JPEG/.test(text($('db-post'))) && /JPEG/.test(text(s.sw.document.querySelector('.sim-tally-h .sim-cpu'))));
  check('…said in the head-to-head band: this window\'s tally, you first', $('db-post').matches('.x-h2h') && !$('db-post').classList.contains('hidden')
    && [...$('db-post').querySelectorAll('.x-score-n')].map(text).join(' ') === '1 - 0' && /You.*JPEG/.test(text($('db-post').querySelector('.x-score')))
    && $('db-post').querySelector('.x-score .d-pf.is-you') && $('db-post').querySelector('.x-score .d-pf.is-them'), text($('db-post')));
  check('…no rematch, edit or swap for a guest: its launch is New encounter', /^New encounter/.test(text($('db-rematch'))) && $('db-new').classList.contains('hidden')
    && $('db-edit').classList.contains('hidden') && $('db-swap').classList.contains('hidden'), text($('db-rematch')));
  check('…the survivors from the guest\'s side: its own losses, the host by name, undimmed without kills, and no top struct', text($('db-lost-you')) === 'lost 1 of 9' && text($('db-lost-cpu')) === 'lost 4 of 9'
    && text($('db-them')) === 'JPEG' && $('db-chips-you').querySelectorAll('.d-tile.is-friend').length > 0 && !$('debrief-screen').querySelector('.x-chips .is-dead') && $('db-mvp').classList.contains('hidden'),
    text($('db-lost-you')) + ' / ' + text($('db-lost-cpu')));
  check('…Share stays for them, and the result is the head-to-head band', !$('db-code').classList.contains('hidden') && $('db-code').closest('.x-sec')
    && $('db-post').matches('.x-h2h'));
  check('…its facts read the match\'s 4 s, while the board keeps the battle\'s own block time', /4 s chain/.test(text($('debrief-meta')))
    && s.sw.Simulator.getSettings().blockMs === config.blockMs, text($('debrief-meta')) + ' | ' + s.sw.Simulator.getSettings().blockMs);
  $('db-code').click(); $('db-copy').click();
  await tick(20);
  {
    const got = (s.sw.__copied || []).slice(-1)[0] || '';
    const m = /^Victory vs JPEG · \d\d:\d\d · \d+ blocks? · lost 1 of 9 — https:\/\/structs\.app\/sim\/([A-Za-z0-9_-]+)$/.exec(got);
    const d = m && Code.decode(m[1]);
    check('Copy link after a live battle: the line against the person, then the battle from your own side — no results code (it reads You v Computer)',
      !!d && d.blockMs === config.blockMs && d.charge.player === 6 && d.charge.computer === 9, got);
  }
  s.close();
}

/* ── The direct line: two SimRTC ends over a fake RTCPeerConnection ────── */
{
  console.log('\n— live: the direct line');
  const rdom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' });
  const rw = rdom.window;
  // An in-memory peer connection: an offer names its maker, the answer joins
  // the two ends' channels. Enough to drive the handshake and the frames.
  const made = {};
  let n = 0;
  class Chan {
    constructor() { this.readyState = 'connecting'; this.peer = null; }
    send(d) { const p = this.peer; setTimeout(() => p.onmessage && p.onmessage({ data: d }), 0); }
    close() { this.readyState = 'closed'; if (this.onclose) this.onclose(); }
    open() { this.readyState = 'open'; if (this.onopen) this.onopen(); }
  }
  class PC {
    constructor(cfg) { this.cfg = cfg; this.id = ++n; this.iceGatheringState = 'complete'; this.signalingState = 'stable'; this.connectionState = 'new'; }
    createDataChannel() { this.ch = new Chan(); return this.ch; }
    createOffer() { return Promise.resolve({ type: 'offer', sdp: 'v=0 offer ' + this.id }); }
    createAnswer() { return Promise.resolve({ type: 'answer', sdp: 'v=0 answer ' + this.id }); }
    setLocalDescription(d) { this.localDescription = d; if (d.type === 'offer') { this.signalingState = 'have-local-offer'; made[d.sdp] = this; } return Promise.resolve(); }
    setRemoteDescription(d) {
      if (d.type === 'offer') { this.offerer = made[d.sdp]; this.offerer.answerer = this; }
      else {
        const mine = this.ch, theirs = new Chan();
        mine.peer = theirs; theirs.peer = mine;
        this.answerer.ondatachannel({ channel: theirs });
        setTimeout(() => { mine.open(); theirs.open(); }, 0);
      }
      return Promise.resolve();
    }
    addEventListener() {}
    addIceCandidate() { return Promise.resolve(); }
    close() {}
  }
  rw.eval(read('frontend/simulator-rtc.js'));
  const noRtc = rw.SimRTC({ signal: () => {}, onFrame: () => {} });
  check('no RTCPeerConnection: unsupported, and every send says so (the room carries it)', !noRtc.supported() && noRtc.send({ v: 1, kind: 'ping' }) === false);
  rw.RTCPeerConnection = PC;
  const wire = [], gotHost = [], gotGuest = [], states = { host: [], guest: [] };
  let host, guest;
  host = rw.SimRTC({ iceServers: () => Promise.resolve([{ urls: ['turn:t.example'], username: 'u', credential: 'c' }]),
    signal: (f) => { wire.push(f); guest.signal(f); }, onFrame: (f) => gotHost.push(f), onState: (st) => states.host.push(st) });
  guest = rw.SimRTC({ iceServers: () => Promise.resolve([]),
    signal: (f) => { wire.push(f); host.signal(f); }, onFrame: (f) => gotGuest.push(f), onState: (st) => states.guest.push(st) });
  check('before the line opens, a send falls to the room', host.send({ v: 1, kind: 'ping' }) === false);
  host.start();
  await tick(30);
  check('the handshake is two room frames: one offer, one answer, candidates inside', wire.length === 2 && wire[0].kind === 'rtc' && wire[0].desc.type === 'offer' && wire[1].desc.type === 'answer');
  check('…and both ends open', host.state() === 'open' && guest.state() === 'open', states.host.join('>') + ' / ' + states.guest.join('>'));
  check('…the homeserver\'s TURN when it has one, public STUN when it has none', made['v=0 offer 1'].cfg.iceServers[0].urls[0] === 'turn:t.example'
    && made['v=0 offer 1'].answerer.cfg.iceServers[0].urls[0].startsWith('stun:'));
  check('then frames go player to player', host.send({ v: 1, kind: 'tick', block: 9, events: [] }) && guest.send({ v: 1, kind: 'move', action: 'attack', args: {} }));
  await tick(10);
  check('…and arrive whole', gotGuest.length === 1 && gotGuest[0].kind === 'tick' && gotHost.length === 1 && gotHost[0].action === 'attack');
  const chan = made['v=0 offer 1'].ch.peer;
  chan.onmessage({ data: JSON.stringify({ v: 1, kind: 'rtc', desc: {} }) });
  chan.onmessage({ data: JSON.stringify({ v: 2, kind: 'tick' }) });
  chan.onmessage({ data: '{not json' });
  chan.onmessage({ data: JSON.stringify({ v: 1, kind: 'ping', pad: 'x'.repeat(70000) }) });
  check('what arrives is checked like a room frame: kind, version, size', gotGuest.length === 1);
  guest.signal({ v: 1, kind: 'rtc', desc: { type: 'offer', sdp: 'v=0 offer 99' } });
  check('a second offer is not a renegotiation: one line per battle', guest.state() === 'open');
  made['v=0 offer 1'].ch.close();
  check('a line that drops says so — lost — and sends fall to the room again', host.state() === 'lost' && host.send({ v: 1, kind: 'ping' }) === false);
  guest.close();
  check('closed is closed', guest.state() === 'closed' && guest.send({ v: 1, kind: 'ping' }) === false);
}

{
  console.log('\n— live: the host\'s simulator');
  const frames = [], statuses = [], opened = [];
  const s = await simulator({ kind: 'addressed', player_id: '1-61', name: 'JPEG', pfp_attrs: null }, {
    matrix_sim_live_open: (a) => { opened.push(a); return { guild_id: '0-1', room_id: '!dm:h', match_room: '!m:h', invite_event: '$inv', me: '@1-1:h', block_ms: 4000, guest: { user_id: '@1-61:h', name: 'JPEG' } }; },
    matrix_sim_live_send: (a) => { frames.push(a.frame); return { event_id: '$x' }; },
    matrix_sim_live_status: (a) => { statuses.push(a.frame); return { event_id: '$s' }; },
    matrix_person: (a) => ({ user_id: a.userId, name: 'JPEG', pfp_attrs: null, player_id: '1-61' }),
    matrix_timeline: () => ({ messages: [] }),
  });
  await tick(50);
  const { $, subs } = s;
  const fire = (frame, sender = '@1-61:h') => (subs['matrix::sim'] || []).forEach((cb) => cb({ payload: { room_id: '!m:h', sender, frame } }));
  check('addressed: Play live sits beside Send', !$('play-live').classList.contains('hidden') && $('send-to').nextElementSibling === $('play-live'));
  $('play-live').click();
  await tick(30);
  // No DM with them yet (no rooms here): their own row, picked.
  check('…its picker has them picked, a DM or not', $('live-rooms').querySelector('input:checked') && /^Invite JPEG$/.test(text($('live-send'))) && !$('live-send').disabled);
  $('live-send').click();
  await tick(30);
  check('…which opens a match by code, for that player, at 4 s blocks', opened.length === 1 && opened[0].toPlayer === '1-61' && !opened[0].roomId && opened[0].battle && opened[0].blockMs === 4000);
  check('…and gives way to the lobby: no picker, no Play live', !$('live-dialog') && $('play-live').classList.contains('hidden'));
  check('the host waits in the lobby for them', /Live battle/.test(text($('challenge'))) && /Waiting for JPEG/.test(text($('challenge'))));
  fire({ v: 1, kind: 'hello' }, '@1-99:h');
  check('…a stranger\'s hello is not the invited guest', /Waiting for JPEG/.test(text($('challenge'))));
  fire({ v: 1, kind: 'hello' });
  await tick(20);
  check('the guest\'s hello seats them, named from the chain', !/Waiting for/.test(text($('challenge'))) && /JPEG/.test(text($('challenge'))) && statuses.some((f) => f.state === 'lobby' && f.guest === '@1-61:h'));
  $('start').click();
  fire({ v: 1, kind: 'ready', ready: true });
  await tick(30);
  check('both ready: the host says start and the room hears it is live', frames.some((f) => f.kind === 'start' && f.battle) && statuses.some((f) => f.state === 'live'));
  const h = s.sw.Simulator.getHost();
  check('…and the battle runs here, with no computer', s.sw.document.body.dataset.screen === 'battle' && h && h.ai === null && h.cpu.name === 'JPEG');
  h.start(); h.block();
  await tick(20);
  check('each block is a tick to the match room', frames.some((f) => f.kind === 'tick'));
  fire({ v: 1, kind: 'leave', forfeit: true });
  await tick(2700);
  check('the guest leaving is the host\'s win, posted back as ended', h.finished && h.finished.winner === 'you' && statuses.some((f) => f.state === 'ended' && f.winner === '@1-1:h')
    && frames.some((f) => f.kind === 'end' && f.winner === 'host'));
  check('…and the debrief says so, in the head-to-head band', /You beat JPEG/.test(text($('db-post'))) && $('db-post').matches('.x-h2h'), text($('db-post')));
  check('…the battle ran at the match\'s 4 s and its facts say so; the board keeps the battle\'s own block time', h.blockMs === 4000 && /4 s chain/.test(text($('debrief-meta')))
    && s.sw.Simulator.getSettings().blockMs === Code.decode(opened[0].battle).blockMs, h.blockMs + ' | ' + text($('debrief-meta')) + ' | ' + s.sw.Simulator.getSettings().blockMs);
  $('db-code').click(); $('db-copy').click();
  await tick(20);
  {
    const got = (s.sw.__copied || []).slice(-1)[0] || '';
    check('Copy link after a live battle: the line against the person, then the battle that was played — no results code',
      new RegExp('^Victory vs JPEG · \\d\\d:\\d\\d · \\d+ blocks? · lost \\d+ of \\d+ — https://structs\\.app/sim/' + opened[0].battle + '$').test(got), got);
  }
  $('db-code').click(); $('db-post-to').click();
  await tick(20);
  check('…Post to carries the same line', !!$('post-dialog') && /^Victory vs JPEG/.test(text($('post-what'))), text($('post-what')));
  s.sw.Simulator.social.closePost();
  $('db-rematch').click();
  await tick(30);
  check('Rematch opens the next match: the same battle, at 4 s', opened.length === 2 && opened[1].battle === opened[0].battle && opened[1].blockMs === 4000,
    JSON.stringify(opened.map((o) => [o.battle && o.battle.slice(0, 12), o.blockMs])));
  s.close();
}

{
  console.log('\n— live: the invite in Comms');
  const v = (extra) => Object.assign({ frame: Object.assign({}, frame, { kind: 'invite', match: '!m:h', block_ms: 6000 }), me, author: { name: 'Marklifer', self: false }, ts: Date.now() }, extra);
  const open = Card.inviteRow(v({}), { onAccept: () => {}, onWatch: () => {} });
  check('an open invite: anyone may Accept', Card.inviteState(v({})) === 'open' && [...open.querySelectorAll('.pc-act')].map((a) => a.title).join(',') === 'Accept');
  check('…addressed to you: For you', Card.inviteState(v({ frame: Object.assign({}, frame, { kind: 'invite', match: '!m:h', block_ms: 6000, to: [me] }) })) === 'for-you');
  check('…to someone else: no Accept', Card.inviteState(v({ frame: Object.assign({}, frame, { kind: 'invite', match: '!m:h', block_ms: 6000, to: ['@1-9:h'] }) })) === 'theirs');
  check('…your own: Waiting', Card.inviteState(v({ author: { name: 'You', self: true } })) === 'waiting');
  check('…untaken for a quarter hour: Lapsed', Card.inviteState(v({ ts: Date.now() - 16 * 60 * 1000 })) === 'lapsed');
  const liveRow = Card.inviteRow(v({ live: { state: 'live', guest_name: 'JPEG' } }), { onAccept: () => {}, onWatch: () => {} });
  check('playing: Live, who v whom, and Watch', /Marklifer v JPEG/.test(text(liveRow.querySelector('.pc-id'))) && text(liveRow.querySelector('.sui-badge')) === 'Live'
    && [...liveRow.querySelectorAll('.pc-act')].map((a) => a.title).join(',') === 'Watch');
  const ended = Card.inviteRow(v({ live: { state: 'ended', guest_name: 'JPEG', winner_name: 'JPEG' } }), {});
  check('over: who won', /JPEG won · Marklifer v JPEG/.test(text(ended.querySelector('.pc-id'))) && !ended.querySelector('.pc-act[title="Accept"]'));
}

console.log(failures ? failures + ' failing check(s)' : 'all checks passed');
process.exit(failures ? 1 : 0);
