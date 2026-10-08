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
//    into the thread, a battle addressed to a player is sent to them, and
//    Post to… lists rooms and posts by codes alone.
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
    && /T\.Xue beat your best on Spearpoint 02:41 · lost 1/.test(text(line)), text(line));
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
  const sdom = await JSDOM.fromFile(page, {
    url: pathToFileURL(page).href, runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true,
    beforeParse(sw) {
      sw.HTMLCanvasElement.prototype.getContext = () => null;
      sw.navigator.clipboard = { writeText: () => Promise.resolve() };
      let pending = context;
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
  return { sw, calls, subs, $: (id) => sw.document.getElementById(id), close: () => sdom.window.close() };
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
  check('…the ladder, you marked as You', $('challenge').querySelectorAll('.sim-run').length === 2 && /You/.test(text($('challenge').querySelector('.sim-run-me'))));
  check('…and the thread with a reply box', /guard the command ship/.test(text($('challenge').querySelector('.sim-thread'))) && $('challenge').querySelector('.sim-reply input'));
  check('the fleets are locked: tagged, Mirror and Swap gone, empty slots dead', !$('locked-chip').classList.contains('hidden') && /Spearpoint fleets/.test(text($('locked-chip')))
    && $('mirror').classList.contains('hidden') && $('swap').classList.contains('hidden')
    && [...sw.document.querySelectorAll('#arena .slot')].filter((b) => !b.dataset.unit).every((b) => b.disabled));
  const bs = sw.document.querySelector('#arena .slot[data-unit="player-space-0"]');
  bs.click();
  check('…a struct can be looked at but not changed or removed', /Battleship/.test(text($('inspector'))) && !/Change|Remove/.test(text($('inspector'))) && $('inspector').querySelector('select').disabled);

  const input = $('challenge').querySelector('.sim-reply input');
  input.value = 'running it back';
  input.dispatchEvent(new sw.Event('input'));
  $('challenge').querySelector('.sim-reply').dispatchEvent(new sw.Event('submit', { cancelable: true }));
  await tick(20);
  const reply = s.calls.filter((c) => c[0] === 'matrix_sim_reply')[0];
  check('a reply goes into this battle\'s thread and nowhere else', reply && reply[1].roomId === '!r:h' && reply[1].eventId === '$root' && reply[1].body === 'running it back');

  // A finished run, debriefed: as showDebrief hands it over.
  const mine = result('player', 1, 76, 151);
  sw.document.body.dataset.screen = 'debrief';
  sw.Simulator.social.debrief(JSON.parse(JSON.stringify(Object.assign({ preset: 'difficult' }, config))), mine);
  await tick(30);
  check('a best posts itself, into the thread, by codes alone', posts.length === 1 && posts[0].thread === '$root' && posts[0].battle === battle && posts[0].result === mine
    && Object.keys(posts[0]).sort().join() === 'battle,guildId,result,roomId,thread');
  check('…and the debrief says so, with an Undo', /New best · posted/.test(text($('db-post'))) && /Undo/.test(text($('db-post'))) && !$('db-post').classList.contains('hidden'), text($('db-post')));
  [...$('db-post').querySelectorAll('button')].filter((b) => /Undo/.test(b.textContent))[0].click();
  await tick(20);
  const undo = s.calls.filter((c) => c[0] === 'matrix_redact')[0];
  check('…Undo takes the post back', undo && undo[1].eventId === '$mine' && /Taken back/.test(text($('db-post'))));

  // Edited fleets are a different battle: never posted.
  const edited = JSON.parse(JSON.stringify(config)); edited.units.pop();
  sw.Simulator.social.debrief(edited, mine);
  await tick(20);
  check('a run on edited fleets is not the challenge and does not post', posts.length === 1 && /Your own battle/.test(text($('db-post'))));

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
  check('who it is for, above the round', !$('addressed').classList.contains('hidden') && /For JPEG/.test(text($('addressed'))));
  check('…and the Send button names them', !$('send-to').classList.contains('hidden') && /Send to JPEG/.test(text($('send-to'))));
  $('send-to').click();
  await tick(20);
  check('Send posts the battle to them by player id, not by room', posts.length === 1 && posts[0].toPlayer === '1-61' && posts[0].battle && !posts[0].roomId && !posts[0].result);
  $('addressed-clear').click();
  check('× makes it a sandbox again', $('addressed').classList.contains('hidden') && $('send-to').classList.contains('hidden'));
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
  check('the sheet lists the rooms, the first picked', $('post-rooms').querySelectorAll('.sim-room').length === 2 && /Post to SN\.Corporation/.test(text($('post-send'))));
  $('post-find').value = 'jp';
  $('post-find').dispatchEvent(new s.sw.Event('input'));
  check('…typing narrows it', $('post-rooms').querySelectorAll('.sim-room').length === 1);
  $('post-rooms').querySelector('.sim-room').click();
  $('post-send').click();
  await tick(20);
  check('…and Post sends the battle code to that room, nothing else', posts.length === 1 && posts[0].roomId === '!b:h' && posts[0].guildId === '0-5' && posts[0].battle && posts[0].result == null);
  check('…then closes', s.$('post-dialog').classList.contains('hidden'));
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
  const s = await simulator({ kind: 'live', role: 'guest', guild_id: '0-1', room_id: '!r:h', invite_event: '$inv', match_room: '!m:h', battle, block_ms: 6000,
    host: '@1-61:h', host_name: 'JPEG', host_pfp: null, me: '@1-1:h' }, {
    matrix_sim_live_send: (a) => { frames.push(a.frame); return { event_id: '$x' }; },
    matrix_timeline: () => ({ messages: [{ event_id: '$c1', sender: '@1-61:h', sender_name: 'JPEG', kind: 'text', body: 'gl', ts: 1 }] }),
  });
  await tick(50);
  const { $, subs } = s;
  const fire = (frame, sender = '@1-61:h') => (subs['matrix::sim'] || []).forEach((cb) => cb({ payload: { room_id: '!m:h', sender, frame } }));
  check('joining says hello to the host', frames.some((f) => f.kind === 'hello'));
  check('the lobby: Live battle panel, both seats, the match chat', /Live battle/.test(text($('challenge'))) && /JPEG/.test(text($('challenge'))) && /You/.test(text($('challenge'))) && /gl/.test(text($('challenge'))));
  check('…fleets fixed, and the header button says Ready', $('round').classList.contains('hidden') && /^Ready/.test(text($('start'))) && $('mirror').classList.contains('hidden'));
  $('start').click();
  await tick(20);
  check('Ready tells the host', frames.some((f) => f.kind === 'ready' && f.ready === true) && /waiting/i.test(text($('start'))), JSON.stringify(frames) + ' | ' + text($('start')) + ' | disabled=' + $('start').disabled);
  fire({ v: 1, kind: 'ready', ready: true }, '@1-99:h');
  const hostSeat = () => text($('challenge').querySelector('.sim-run'));
  check('…a frame from anyone but the host is ignored', /JPEG/.test(hostSeat()) && !/Ready/.test(hostSeat()), hostSeat());
  fire({ v: 1, kind: 'ready', ready: true });
  check('…the host\'s own ready shows on its seat', /Ready/.test(hostSeat()), hostSeat());
  fire({ v: 1, kind: 'start', battle, block_ms: 6000 });
  await tick(30);
  check('the host\'s start begins the battle here, the board replaying its ticks', s.sw.document.body.dataset.screen === 'battle' && s.sw.Simulator.getHost() instanceof s.sw.SimLive.RemoteHost);
  check('…with the Live chip, and no pause for a battle between two', /Live/.test(text($('chips'))) && s.sw.getComputedStyle($('pause')).display === 'none');
  s.sw.Simulator.getHost().end({ v: 1, kind: 'end', winner: 'guest', summary: { stats: {}, lost: { '1-1': 4, '1-2': 1 }, fielded: { '1-1': 9, '1-2': 9 }, kills: [] } });
  await tick(2700);
  check('the host\'s end is the debrief: you beat them', s.sw.document.body.dataset.screen === 'debrief' && /You beat JPEG/.test(text($('db-post'))) && /JPEG/.test(text(s.sw.document.querySelector('.sim-tally-h .sim-cpu'))));
  check('…no rematch, edit or swap for a guest', $('db-rematch').classList.contains('hidden') && $('db-edit').classList.contains('hidden') && $('db-swap').classList.contains('hidden'));
  s.close();
}

{
  console.log('\n— live: the host\'s simulator');
  const frames = [], statuses = [], opened = [];
  const s = await simulator({ kind: 'addressed', player_id: '1-61', name: 'JPEG', pfp_attrs: null }, {
    matrix_sim_live_open: (a) => { opened.push(a); return { guild_id: '0-1', room_id: '!dm:h', match_room: '!m:h', invite_event: '$inv', me: '@1-1:h', block_ms: 6000, guest: { user_id: '@1-61:h', name: 'JPEG' } }; },
    matrix_sim_live_send: (a) => { frames.push(a.frame); return { event_id: '$x' }; },
    matrix_sim_live_status: (a) => { statuses.push(a.frame); return { event_id: '$s' }; },
    matrix_person: (a) => ({ user_id: a.userId, name: 'JPEG', pfp_attrs: null, player_id: '1-61' }),
    matrix_timeline: () => ({ messages: [] }),
  });
  await tick(50);
  const { $, subs } = s;
  const fire = (frame, sender = '@1-61:h') => (subs['matrix::sim'] || []).forEach((cb) => cb({ payload: { room_id: '!m:h', sender, frame } }));
  check('addressed: Play JPEG live sits under Send', !$('live-to').classList.contains('hidden') && /Play JPEG live/.test(text($('live-to'))));
  $('live-to').click();
  await tick(30);
  check('…which opens a match by code, for that player, at chain speed', opened.length === 1 && opened[0].toPlayer === '1-61' && opened[0].battle && opened[0].blockMs === 6000);
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
  check('…and the debrief says so', /You beat JPEG/.test(text($('db-post'))), text($('db-post')));
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
