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
  check('addressed to you: For you and the time to beat — who sent it is the message header, not said again', Card.state({ frame: Object.assign({}, frame, { to: [me] }), me, author: { self: false } }) === 'for-you'
    && text(forYou.querySelector('.sui-badge')) === 'For you' && /^9 v 9 · to beat 02:55$/.test(text(forYou.querySelector('.pc-id'))) && !/Marklifer/.test(text(forYou)) && forYou.classList.contains('sc-warn'));
  check('…a challenge wears the battle glyph, toned by its state — not a fleet\'s Command Ship', forYou.querySelector('.gc-emblem i.icon-raid.sc-tone-warning') && !forYou.querySelector('.gc-emblem img')
    && open.querySelector('.gc-emblem i.icon-raid.sc-tone-player'));

  const mine = { frame, me, ladder: [entry(1, me, 'Marklifer', outcome('Victory', 'player', '02:31', 1)), entry(2, '@1-9:h', 'T.Xue', outcome('Victory', 'player', '02:41', 1))] };
  check('holding first: Your best, "1st of 2"', Card.state(mine) === 'best' && /1st of 2/.test(text(Card.row(mine).querySelector('.pc-id')))
    && text(Card.row(mine).querySelector('.sui-badge')) === 'Your best');
  const beaten = Object.assign({}, played, { beaten: true, ladder: played.ladder.concat([entry(3, me, 'Marklifer', outcome('Victory', 'player', '03:30', 3))]) });
  check('knocked off: Beaten, theirs against yours, red stripe', Card.state(beaten) === 'beaten' && /T.Xue 02:41 · you 03:30/.test(text(Card.row(beaten).querySelector('.pc-id'))) && Card.row(beaten).classList.contains('sc-bad'));

  const shared = Card.resultRow({ frame: Object.assign({}, frame, { kind: 'result', outcome: outcome('Defeat', 'computer', '05:02', 9) }), author: { name: 'Korrin' } });
  check('a shared result: the battle by name, the verdict as its badge, the figures as readings', text(shared.querySelector('.pc-nm')) === 'Spearpoint'
    && text(shared.querySelector('.sui-badge')) === 'Defeat' && shared.querySelector('.sui-badge').classList.contains('sui-mod-destructive')
    && text(shared.querySelector('.pc-id')) === '9 v 9 · 76 blocks' && !/Korrin/.test(text(shared)) && shared.classList.contains('sc-bad'),
    text(shared.querySelector('.pc-id')));
  const sharedReads = [...shared.querySelectorAll('.pc-res')];
  check('…its time behind the defeat glyph in the enemy tone, its losses behind the destroyed sprite', sharedReads.length === 2
    && text(sharedReads[0]) === '05:02' && sharedReads[0].querySelector('i.icon-alert') && sharedReads[0].classList.contains('sc-bad-text') && !shared.querySelector('.icon-close')
    && text(sharedReads[1]) === '9/9' && sharedReads[1].querySelector('i.sui-icon-md.sui-icon-destroyed'));
  check('…its emblem is the verdict glyph; the row carries no outcome class of its own', shared.querySelector('.gc-emblem i.icon-alert.sc-tone-enemy')
    && !shared.classList.contains('chl-lost') && shared.classList.contains('chl-row'));
  check('the verdict vocabulary: tick, subtract, alert — each in its tone', Card.verdictGlyph({ winner: 'player' }) === 'icon-success' && Card.verdictGlyph({ winner: 'draw' }) === 'icon-subtract'
    && Card.verdictGlyph({ winner: 'computer' }) === 'icon-alert' && Card.verdictTone({ winner: 'player' }) === 'sc-ok' && Card.verdictTone({ winner: 'draw' }) === 'sc-tone-warning'
    && Card.verdictTone({ winner: 'computer' }) === 'sc-bad-text');
}

{
  console.log('\n— the card');
  let played = 0, replies = 0;
  const view = { frame, me, author: { name: 'JPEG', self: false }, reply_count: 3, replies: [{ name: 'Netlag', body: 'the cruiser block on 49 is the whole fight' }],
    ladder: [entry(1, '@1-9:h', 'T.Xue', outcome('Victory', 'player', '02:41', 1)), entry(2, me, 'Marklifer', outcome('Victory', 'player', '02:55', 2)), entry(3, '@1-1031:h', 'Korrin', outcome('Defeat', 'computer', '05:02', 9))] };
  const c = Card.card(view, { onPlay: () => played++, onReplies: () => replies++, onCopy: () => {}, onMore: () => {}, onCollapse: () => {} });
  check('the planet-card frame: the battle glyph and name, its size, no battle code', c.classList.contains('sui-planet-card') && text(c.querySelector('.pc-nm')) === 'Spearpoint'
    && c.querySelector('.sui-planet-card-header-label > i.sui-icon.sui-icon-md.icon-raid')
    && text(c.querySelector('.sui-planet-card-header .pc-id')) === '9 v 9' && !text(c).includes(battle), text(c.querySelector('.pc-id')));
  check('…block time a quiet mark beside the doors', /^2 s$/.test(text(c.querySelector('.pc-foot .pc-mark'))) && c.querySelector('.pc-foot .pc-mark i.icon-in-progress'));
  const stats = [...c.querySelectorAll('.chl-stats.pc-record .pc-rec')].map((n) => text(n.querySelector('.pc-rec-v')) + ' ' + text(n.querySelector('.pc-rec-l'))).join(' · ');
  check('…the miniature, the tallies (the player card\'s record), the ladder', c.querySelector('.chl-board') && stats === '3 Played · 2 Won · 02:41 Best' && c.querySelectorAll('.chl-run').length === 3, stats);
  check('…Best in its run\'s verdict tone', c.querySelectorAll('.pc-rec-v')[2].classList.contains('sc-ok'));
  check('…the ambits are the game\'s sprites, not letters', [...c.querySelectorAll('.chl-amb')].map((a) => a.querySelector('i.sui-icon.sui-icon-sm') && a.querySelector('i').className.split(' ').pop()).join() === 'sui-icon-space,sui-icon-air,sui-icon-land,sui-icon-water');
  check('…you are marked on the ladder', c.querySelector('.chl-run.chl-me') && /Marklifer/.test(text(c.querySelector('.chl-run.chl-me'))));
  const runs = [...c.querySelectorAll('.chl-run')];
  check('…each run: rank as a label, then its time behind the verdict glyph and what it lost, as readings', runs.every((r) => r.querySelector('.chl-rank.sui-text-label') && r.querySelectorAll('.pc-reads .pc-res').length === 2)
    && runs[0].querySelector('.pc-res i.icon-success') && runs[2].querySelector('.pc-res.sc-bad-text i.icon-alert') && text(runs[2].querySelectorAll('.pc-res')[1]) === '9'
    && !/Victory|Defeat/.test(text(c.querySelector('.chl-ladder'))));
  const compact = Card.ladderList(view, { compact: true });
  check('…and compact, the losses are left out', [...compact.querySelectorAll('.chl-run')].every((r) => r.querySelectorAll('.pc-res').length === 1));
  check('…the thread as Comms\' own thread pointer', c.querySelector('a.chat-reply-quote.chat-mod-thread.chl-thread') && text(c.querySelector('.chl-thread .chat-reply-who')) === 'Netlag'
    && /^the cruiser block/.test(text(c.querySelector('.chl-said'))) && text(c.querySelector('.chl-replies')) === '3 replies' && c.querySelector('.chl-replies.sui-text-label'));
  const cta = c.querySelector('.sui-planet-card-body > .sui-screen-btn-flex-wrapper');
  check('…Play last in the body, across it; the foot holds only the quiet doors', cta && cta.querySelector('.chl-play')
    && (!cta.nextElementSibling || cta.nextElementSibling.classList.contains('pc-foot')) && !c.querySelector('.pc-foot .chl-play'));
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
  const lost = Object.assign({}, best, { event_id: '$lost', sim: Object.assign({}, best.sim, { outcome: outcome('Defeat', 'computer', '05:02', 9) }) });
  const lostLine = sim.simLine(lost);
  check('a best that is a defeat opens on the defeat glyph, never a tick', lostLine.querySelector('i.icon-alert.sc-bad-text') && !lostLine.querySelector('.icon-success'));
}

{
  console.log('\n— rows open to their card');
  const S = { view: 'room', roomId: '!r:h', guildId: '0-1', profile: { user_id: me }, messages: [] };
  const host = w.document.createElement('div');
  let draw = () => {};
  const sim = w.ChatSim({
    el: (tag, cls, t) => { const e = w.document.createElement(tag); if (cls) e.className = cls; if (t != null) e.textContent = t; return e; },
    icon: (name, size) => { const i = w.document.createElement('i'); i.className = 'sui-icon ' + (size || 'sui-icon-md') + ' ' + name; return i; },
    invoke: () => Promise.resolve(null), render: () => draw(), serverIdOf: (m) => m.event_id, S, Chat: {},
  });
  const pasted = { event_id: '$paste', sender: '@1-9:h', sender_name: 'Korrin', body: frame.link, ts: 9,
    sim: Object.assign({}, frame, { kind: 'result', pasted: true, outcome: outcome('Defeat', 'computer', '05:02', 9) }) };
  S.messages = [pasted];
  draw = () => { host.textContent = ''; host.appendChild(sim.simNode(pasted)); };
  draw();
  check('a pasted result is a row', host.querySelector('.chat-mod-row [data-kind="challenge-result"]') && !host.querySelector('.chl-card'));
  host.querySelector('.pc-act[title="More"]').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  const items = [...host.querySelectorAll('.chat-ref-menu-item')].map((a) => text(a));
  check('…its menu opens on "Open the card", and the More door lights while it is open', items[0] === 'Open the card' && host.querySelector('.pc-act[title="More"].sc-on'), items.join(','));
  host.querySelector('.chat-ref-menu').dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  check('…Escape closes it and the door goes quiet', !host.querySelector('.chat-ref-menu') && !host.querySelector('.pc-act.sc-on'));
  host.querySelector('.pc-row').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  check('clicking the row opens the battle\'s card, not a challenge row', host.querySelector('.chl-card') && !host.querySelector('.chat-mod-row'));
  host.querySelector('.pc-act[title="Collapse"]').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  check('…and its collapse door gives the row back', host.querySelector('.chat-mod-row [data-kind="challenge-result"]') && !host.querySelector('.chl-card'));
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
    && /Difficult/.test(text($('challenge'))) && /charge 9 · 9/.test(text($('challenge'))));
  {
    // P8: the panel is the game's data card; its state is a badge and its settings one hint line.
    const ch = $('challenge');
    const head = ch.querySelector('.sim-card-head');
    check('…a data card: its tag names it, a frameless close leaves it', ch.classList.contains('sui-data-card') && !ch.classList.contains('sim-card')
      && head && /^Challenge$/.test(text(head.querySelector('.sui-data-card-header'))) && head.querySelector('a.sui-screen-nav-close[title="Leave"] i.sui-icon.sui-icon-sm.icon-close')
      && ch.querySelector('.sui-data-card-body.sui-mod-spacing-xl'));
    const set = ch.querySelector('.sim-settings');
    check('…difficulty is the game\'s badge, the rest one hint line — no invented chips', set && /^Difficult$/.test(text(set.querySelector('.sui-badge.sui-mod-default')))
      && /^\d+ v \d+ · 2 s blocks · charge 9 · 9$/.test(text(set.querySelector('.sui-text-hint'))) && !ch.querySelector('.sim-chip, .sim-pfp'), set && text(set));
    check('…who posted it is the shared person line', /JPEG/.test(text(ch.querySelector('.sim-by .pc-person'))) && /SN\.Corporation/.test(text(ch.querySelector('.sim-by .sim-by-where'))));
  }
  check('…the ladder is the Comms card\'s own, you marked', $('challenge').querySelectorAll('.chl-ladder .chl-run').length === 2
    && /Marklifer/.test(text($('challenge').querySelector('.chl-run.chl-me'))) && $('challenge').querySelectorAll('.chl-run .pc-person').length === 2
    && $('challenge').querySelectorAll('.chl-run .sc-ok .icon-success, .chl-run .sc-ok.icon-success').length === 2 && !$('challenge').querySelector('.chl-run .sui-icon-destroyed'),
    $('challenge').querySelector('.chl-ladder') && $('challenge').querySelector('.chl-ladder').outerHTML.slice(0, 600));
  check('…and the thread, read-only, in the rows Comms draws — talking is the Map Viewer\'s rail and Comms', /guard the command ship/.test(text($('challenge').querySelector('.sim-thread')))
    && !$('challenge').querySelector('textarea, .sim-reply'));
  check('the fleets are locked: tagged, Mirror and Swap gone, empty slots dead', !$('locked-chip').classList.contains('hidden') && /Spearpoint fleets/.test(text($('locked-chip')))
    && $('mirror').classList.contains('hidden') && $('swap').classList.contains('hidden')
    && [...sw.document.querySelectorAll('#arena .slot')].filter((b) => !b.dataset.unit).every((b) => b.disabled));
  const bs = sw.document.querySelector('#arena .slot[data-unit="player-space-0"]');
  bs.click();
  check('…a struct can be looked at but not changed or removed', /Battleship/i.test(text($('inspector'))) && !/Change|Remove/.test(text($('inspector'))) && $('inspector').querySelector('select').disabled
    && !$('inspector').querySelector('.sui-panel-btn, .sui-action-bar-btn-group'));
  check('…and its empty slots draw no add glyph', !sw.document.querySelector('#arena .icon-add'));

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
  check('who it is for, in the Round card\'s head beside its tag: For, then the name alone', !$('addressed').classList.contains('hidden')
    && text($('for-l')) === 'For' && text($('addressed-name')) === 'JPEG' && $('addressed').parentNode.matches('#round > .sim-card-head'));
  check('…and Send / Play live sit in the foot beside Start (the page\'s actions)', $('sim-go').contains($('send-to')) && $('sim-go').contains($('live-to'))
    && $('send-to').parentNode === $('start').parentNode);
  check('…and the Send button names them', !$('send-to').classList.contains('hidden') && /Send to JPEG/.test(text($('send-to'))));
  check('…Send the setup\'s one primary, Start battle stepping back to secondary', $('send-to').classList.contains('sui-mod-primary')
    && $('start').classList.contains('sui-mod-secondary') && !$('start').classList.contains('sui-mod-primary')
    && s.sw.document.querySelectorAll('#setup-screen .sui-screen-btn.sui-mod-primary:not(.hidden), #sim-go .sui-screen-btn.sui-mod-primary').length === 1);
  $('send-to').click();
  await tick(20);
  check('Send posts the battle to them by player id, not by room', posts.length === 1 && posts[0].toPlayer === '1-61' && posts[0].battle && !posts[0].roomId && !posts[0].result);
  // P7: a run addressed to them ends on ONE primary — the strip's Send.
  s.sw.document.body.dataset.screen = 'debrief';
  s.sw.Simulator.social.debrief(JSON.parse(JSON.stringify(config)), result('player', 1, 76, 151));
  await tick(20);
  const go = $('db-post').querySelector('.sui-message-system-alert-close-container button.sui-mod-primary');
  check('the debrief offers the send as the game\'s system alert, Send its one primary', $('db-post').matches('.sui-message-system-alert.sui-mod-secondary')
    && go && /^Send to JPEG$/.test(text(go)) && go.querySelector('span') && $('db-rematch').classList.contains('sui-mod-secondary') && !$('db-rematch').classList.contains('sui-mod-primary'),
    $('db-post').outerHTML.slice(0, 300));
  s.sw.document.body.dataset.screen = 'setup';
  $('addressed-clear').click();
  check('× makes it a sandbox again', $('addressed').classList.contains('hidden') && $('send-to').classList.contains('hidden')
    && $('start').classList.contains('sui-mod-primary') && !$('start').classList.contains('sui-mod-secondary'));
  s.close();
}

{
  console.log('\n— the Round and Share cards (P5)');
  const s = await simulator(null);
  await tick(50);
  const { sw, $ } = s;
  const st = () => sw.Simulator.getSettings();
  const round = $('round');
  check('Round is the game\'s form card, its fields two up; Share is the foot\'s group', round.classList.contains('sui-data-card')
    && text(round.querySelector(':scope > .sim-card-head > .sui-data-card-header')) === 'Round'
    && round.querySelector(':scope > .sui-data-card-body.sim-round-b')
    && $('sim-go').contains($('share-card')) && $('share-card').getAttribute('aria-label') === 'Share');
  const enc = () => [...$('encounters').querySelectorAll('input.sui-radio')];
  check('Encounter is four radio rows, Difficult checked, each led by the game\'s radio', enc().length === 4
    && $('encounters').querySelector('input.sui-radio:checked').value === 'difficult'
    && $('encounters').querySelectorAll('label.sui-result-row .sui-radio-container > .sui-radio-display').length === 4
    && $('encounters').querySelector('[role=radiogroup]').getAttribute('aria-labelledby') === 'enc-l');
  const counts = [...$('encounters').querySelectorAll('.sui-resource')];
  check('…its enemy count a struct resource (no size class on the sprite)', counts.length === 4 && counts.map(text).join(' ') === '4 8 12 6-16'
    && counts.every((r) => r.title === 'Enemy structs' && r.querySelector('i.sui-icon.sui-icon-enemy-deployed-structs') && !/sui-icon-(sm|md)/.test(r.querySelector('i').className)));
  check('no invented option buttons or header glyph left on the card', !round.querySelector('.sim-opt, .sim-field-h, .icon-enemy-tile, #ai-down, #ai-up'));
  enc()[3].click();
  const seed1 = $('seed').value;
  enc()[3].click();
  check('Random rolls again on every click, checked or not', st().preset === 'random' && $('seed').value !== seed1 && enc()[3].checked);
  enc()[2].click();
  check('…Hard sets the Opponent with it', st().difficulty === 'hard' && $('ai-level').value === 'hard');
  const sel = $('ai-level');
  check('Opponent is a bare select inside the game\'s field', sel.tagName === 'SELECT' && !sel.className && sel.closest('label.sui-input-text')
    && [...sel.options].map((o) => o.value).join() === 'easy,difficult,hard');
  sel.value = 'easy'; sel.dispatchEvent(new sw.Event('change'));
  check('…and choosing one sets the difficulty', st().difficulty === 'easy');
  check('Seed is the game\'s text field, the reseed a frameless refresh beside it', $('seed').closest('label.sui-input-text') && !$('seed').className
    && $('reseed').classList.contains('set-username-pfp-refresh-btn') && $('reseed').querySelector('i.sui-icon.sui-icon-md.icon-refresh-12'));
  const bt = () => [...$('block-time').querySelectorAll('input.sui-radio')];
  check('Block time is two radio rows with their note trailing', bt().length === 2 && text($('block-time')).includes('training') && text($('block-time')).includes('chain'));
  bt()[1].click();
  check('…picking 6 s sets the block time', st().blockMs === 6000 && bt()[1].checked);
  check('…and the Paused card\'s copy is its own radio group', $('pause-block-time').querySelector('input.sui-radio')
    && $('pause-block-time').querySelector('input.sui-radio').name !== bt()[0].name);
  const field = (id) => $(id).closest('label.sui-input-text');
  check('Opening charge is two SUI steppers, captioned by side', field('charge-player') && field('charge-cpu')
    && field('charge-player').querySelector(':scope > span.sim-you') && field('charge-cpu').querySelector(':scope > span.sim-cpu')
    && $('charge-player').closest('div.sui-input-stepper') && $('charge-player').value === '9');
  const more = field('charge-player').querySelector('button[aria-label="More opening charge"]');
  const less = field('charge-player').querySelector('button[aria-label="Less opening charge"]');
  check('…its buttons are the game\'s secondary − / + glyphs, named for the reader', more && less && more.classList.contains('sui-mod-secondary')
    && more.querySelector('i.sui-icon.sui-icon-md.icon-add') && less.querySelector('i.sui-icon.sui-icon-md.icon-subtract'));
  more.click();
  check('…More raises your charge and keeps the stepper (and its focus) in place', st().charge.player === 10 && $('charge-player').value === '10'
    && field('charge-player').querySelector('button[aria-label="More opening charge"]') === more);
  $('charge-cpu').value = '99'; $('charge-cpu').dispatchEvent(new sw.Event('change'));
  check('…a typed charge is clamped to the maximum and disables More', st().charge.computer === 30 && $('charge-cpu').value === '30'
    && field('charge-cpu').querySelector('button[aria-label="More opening charge"]').disabled);
  $('mirror').click();
  check('…Mirror copies your charge to the computer\'s stepper', st().charge.computer === 10 && $('charge-cpu').value === '10');
  const share = $('share-card');
  check('Share holds Post to…, Copy link and Paste as secondary buttons with their icons and titles', ['post-to', 'export', 'import'].every((id) => share.contains($(id))
    && $(id).classList.contains('sui-mod-secondary') && $(id).querySelector('i.sui-icon.sui-icon-md') && $(id).querySelector('span') && $(id).title)
    && $('export').querySelector('.icon-copy') && $('import').querySelector('.icon-incoming'));
  check('the fleets\' tools sit in the foot too, iconed so they can fold — Mirror, with no game glyph, a word that never folds', ['swap', 'unlock', 'live-room'].every((id) => $('sim-go').contains($(id))
    && $(id).querySelector('i.sui-icon.sui-icon-md') && $(id).title) && $('sim-go').contains($('mirror')) && !$('mirror').querySelector('i') && text($('mirror')) === 'Mirror'
    && $('fleet-head').querySelectorAll('button').length === 0);
  check('every icon on the two cards is a sized SUI icon (sprites excepted)', [...round.querySelectorAll('i'), ...share.querySelectorAll('i')]
    .every((i) => i.classList.contains('sui-icon') && (/sui-icon-(sm|md)\b/.test(i.className) || /sui-icon-enemy-deployed-structs/.test(i.className))));
  s.close();
}

{
  console.log('\n— the fleet board and the inspector (P6)');
  const s = await simulator(null);
  await tick(50);
  const { sw, $ } = s;
  const doc = sw.document, insp = $('inspector');
  const info = () => insp.querySelector('.sim-insp-h .sui-screen-info');
  const lay = (id) => sw.Simulator.getLayout().find((u) => u.id === id);
  const slot = (id) => doc.querySelector('#arena .slot[data-unit="' + id + '"]');
  const btn = (title) => insp.querySelector('a.sui-panel-btn[title="' + title + '"]');
  const esc = () => doc.dispatchEvent(new sw.KeyboardEvent('keydown', { key: 'Escape' }));
  check('fleet counts are struct resources holding the number alone', /^\d+$/.test(text($('count-you'))) && /^\d+$/.test(text($('count-cpu')))
    && $('count-you').parentNode.matches('.sui-resource') && $('count-you').parentNode.querySelector('i.sui-icon.sui-icon-deployed-structs')
    && $('count-cpu').parentNode.querySelector('i.sui-icon.sui-icon-enemy-deployed-structs'));
  check('no defend banner, no hand-made inspector parts', !$('defend-banner') && !insp.classList.contains('sim-card')
    && !doc.querySelector('.sim-name, .sim-weapons, .sim-pick, .sim-opt[aria-label="land"], .sim-check'));
  slot('player-cmd').click();
  check('the inspector is the Action Bar: a side-themed header screen with the slot', info() && info().closest('.sim-insp-h.sui-theme-player > .sui-screen.sui-screen-full-width')
    && text(info()) === 'Land · Command' && !info().classList.contains('sui-mod-inverted'));
  check('…the struct\'s health in the game\'s bar', insp.querySelectorAll('.struct-health-bar > .struct-health-bar-segment.mod-filled').length === 6);
  const sheet = insp.querySelector('.sui-cheatsheet.sim-sheet.sui-theme-player');
  check('…and its cheatsheet, titled model and class', sheet && text(sheet.querySelector('.sui-cheatsheet-title-text')) === 'ST-21 COMMAND SHIP');
  check('…its LOCAL weapon reads as the band it holds, in ambit sprites', sheet && [...sheet.querySelectorAll('.sui-cheatsheet-property')][0].querySelector('i.sui-icon.sui-icon-land')
    && ![...sheet.querySelectorAll('.sui-cheatsheet-property')][0].querySelector('.sui-icon-space'));
  check('…no build cost, and each weapon\'s charge as a battery', sheet && !sheet.querySelector('.sui-cheatsheet-costs > *')
    && sheet.querySelector('.sim-sheet-charge > .sui-battery') && /charge$/.test(sheet.querySelector('.sim-sheet-charge').title));
  const guard = insp.querySelector('select');
  check('Defends is a bare select in the game\'s field', guard && !guard.className && guard.getAttribute('aria-label') === 'Defends'
    && guard.closest('label.sui-input-text') && text(guard.closest('label').querySelector(':scope > span')) === 'Defends');
  check('the abilities are the game\'s panel buttons: Move and Defend for the command ship', btn('Move') && btn('Defend') && !btn('Change') && !btn('Remove')
    && btn('Move').closest('.sui-action-bar-bottom-row.sui-theme-player > .sui-action-bar-btn-group') && btn('Move').querySelector('i.sui-icon.sui-icon-md.icon-move'));
  btn('Move').click();
  check('Move arms a pick: the header inverts to Select Tile and the empty command posts become targets', text(info()) === 'Select Tile' && info().classList.contains('sui-mod-inverted')
    && doc.querySelectorAll('#arena .slot.sim-move-target').length === 3 && btn('Move').classList.contains('sui-mod-active-defense')
    && doc.querySelector('.sim-round-col, #round').inert);
  btn('Move').click();
  check('…a second press cancels it', text(info()) === 'Land · Command' && !doc.querySelector('#arena .sim-move-target') && !doc.querySelector('.sim-round-col, #round').inert);
  btn('Move').click();
  doc.querySelector('#arena .band.water .slot.sim-move-target').click();
  check('…and a target moves the command ship there', lay('player-cmd').ambit === 'water' && text(info()) === 'Water · Command' && !doc.querySelector('#arena .sim-move-target'));
  slot('player-space-1').click();
  btn('Defend').click();
  const mine = sw.Simulator.getLayout().filter((u) => u.side === 'player' && u.id !== 'player-space-1').length;
  check('Defend arms a pick: Select Struct, your other structs the targets, the rest dimmed', text(info()) === 'Select Struct' && info().classList.contains('sui-mod-inverted')
    && doc.querySelectorAll('#arena .slot.eligible').length === mine && slot('computer-cmd').classList.contains('dim') && btn('Defend').classList.contains('sui-mod-active-defense'));
  esc();
  check('…Escape cancels it', !doc.querySelector('#arena .slot.eligible') && text(info()) === 'Space · Slot 2');
  btn('Defend').click();
  slot('computer-cmd').click();
  check('…so does pressing anywhere it cannot land', !doc.querySelector('#arena .slot.eligible') && lay('player-space-1').protects === null);
  slot('player-space-1').click();
  btn('Defend').click();
  slot('player-cmd').click();
  check('…a target sets the ward; the button stays pressed and now clears it', lay('player-space-1').protects === 'player-cmd' && btn('Clear Defense')
    && btn('Clear Defense').classList.contains('sui-mod-active-defense') && insp.querySelector('select').value === 'player-cmd');
  check('…and the board draws the defence web from the selection', doc.querySelector('#arena svg.sim-defweb line') && doc.querySelector('#arena svg.sim-defweb circle'));
  btn('Clear Defense').click();
  check('…pressing it clears the guard', lay('player-space-1').protects === null && btn('Defend') && !btn('Defend').classList.contains('sui-mod-active-defense'));
  btn('Change').click();
  const tiles = () => [...insp.querySelectorAll('.offcanvas-struct-list-layout > a.offcanvas-struct-container')];
  check('Change opens the game\'s Deploy list: a still per type, the current one marked', text(info()) === 'Select Struct' && tiles().length === 3
    && tiles().every((a) => a.querySelector(':scope > .struct-still > img') && a.title && /^Place /.test(a.getAttribute('aria-label')) && !text(a))
    && tiles().filter((a) => a.classList.contains('sim-current')).length === 1 && btn('Change').classList.contains('sui-mod-pressed'));
  check('…with the sheet of the type under the pointer', insp.querySelector('.sim-types-sheet .sui-cheatsheet'));
  esc();
  check('…Escape backs out of it', !insp.querySelector('.offcanvas-struct-list-layout') && text(info()) === 'Space · Slot 2');
  btn('Change').click();
  const other = tiles().find((a) => !a.classList.contains('sim-current'));
  other.click();
  check('…a press places that type', sw.SimulatorTypes.types.find((t) => t.id === lay('player-space-1').type).type === other.title && !insp.querySelector('.offcanvas-struct-list-layout'));
  btn('Remove').click();
  check('Remove empties the slot and the empty slot asks for a struct', !lay('player-space-1') && text(info()) === 'Select Struct' && tiles().length === 3
    && doc.querySelector('#arena .band.space .slot.friendly:not([data-unit]) .icon-add.empty-label'));
  sw.Simulator.getLayout().forEach((u) => { u.protects = null; });
  slot('player-cmd').click();
  check('readiness notes are the game\'s inline alerts', $('checks').children.length && [...$('checks').children].every((c) => c.matches('.sui-message-inline-alert.sui-mod-warning, .sui-message-inline-alert.sui-mod-destructive'))
    && /no defender/.test(text($('checks').querySelector('.sui-mod-warning .sui-message-inline-alert-text'))));
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
  const ctas = (ov) => [...ov.querySelectorAll('.sui-message-system-modal-cta .sui-message-system-modal-cta-btn-wrapper > a.sui-screen-btn')];
  const p = $('paused');
  check('Paused is the game\'s system modal on the board layer, a labelled dialog', p.matches('.sui-message-system-model-overlay.sp-scrim.sim-scrim.hidden')
    && p.parentNode === $('sim-layer') && p.getAttribute('role') === 'dialog' && p.getAttribute('aria-modal') === 'true'
    && text($(p.getAttribute('aria-labelledby'))).startsWith('Paused') && p.querySelector('.sui-message-system-modal-frame-left-middle i.sui-icon.sui-icon-md.icon-in-progress')
    && p.querySelector('#paused-clock.sui-text-label.sui-text-hint') && p.contains($('pause-block-time')) && !doc.querySelector('.sim-card, .sim-overlay'));
  check('…its ways out are its CTAs: the forfeit first, Resume last and the one primary, its chevron after the label',
    ctas(p).map((a) => a.id).join() === 'pause-end,pause-rematch,pause-edit,resume' && $('pause-end').classList.contains('sui-mod-destructive')
    && ctas(p).filter((a) => a.classList.contains('sui-mod-primary')).length === 1 && $('resume').classList.contains('sui-mod-primary')
    && $('resume').lastElementChild.matches('i.icon-chevron-right') && $('resume').firstElementChild.matches('span'));
  const d = $('deploy');
  check('Deploy is the same modal with no CTA row, titled Engagement', d.matches('.sui-message-system-model-overlay.sp-scrim.sim-scrim.hidden')
    && d.querySelector('.sui-message-system-modal-frame-left-middle .icon-raid') && /Engagement/.test(text(d.querySelector('h2'))) && !d.querySelector('.sui-message-system-modal-cta'));

  $('start').click();
  await tick(30);
  check('starting deploys: each side its structs as the game\'s resource and its charge as the 5-chunk battery', open('deploy') && text($('deploy-you')) === '9' && text($('deploy-cpu')) === '9'
    && $('deploy-you').closest('.sui-resource').querySelector('i.sui-icon-deployed-structs') && $('deploy-cpu').closest('.sui-resource').querySelector('i.sui-icon-enemy-deployed-structs')
    && $('deploy-charge-you').matches('.sui-battery.sui-theme-player') && $('deploy-charge-cpu').matches('.sui-battery.sui-theme-enemy')
    && $('deploy-charge-you').querySelectorAll('.sui-battery-chunk').length === 5 && $('deploy-charge-you').querySelectorAll('.sui-mod-filled').length === 5);
  check('…and its reach as the cheatsheet draws it: the range glyph, then one sprite per ambit reached', $('deploy-reach-you').firstElementChild.matches('i.sui-icon.sui-icon-md.icon-range')
    && [...$('deploy-reach-you').children].slice(1).every((i) => /sui-icon-(space|air|land|water)\b/.test(i.className)) && $('deploy-reach-you').children.length > 1);
  check('…while it counts, Pause and End are disabled in the nav', $('end').classList.contains('sui-mod-disabled') && $('pause').classList.contains('sui-mod-disabled'));
  for (let i = 0; i < 80 && (open('deploy') || !host().running); i++) await tick(50);
  check('the countdown ends in the battle', !open('deploy') && host().running);

  $('end').click();
  await tick(10);
  const confirm = () => $('end-title') && $('end-title').closest('.sui-message-system-model-overlay');
  check('End asks first: the system modal, a forfeit and the standing, Cancel then the destructive End battle', confirm() && confirm().getAttribute('role') === 'alertdialog'
    && /Counts as a forfeit · 9\/9 standing/.test(text(confirm())) && confirm().querySelector('.icon-attention')
    && ctas(confirm()).map((a) => a.id).join() === 'end-cancel,end-confirm' && $('end-confirm').classList.contains('sui-mod-destructive') && $('end-cancel').classList.contains('sui-mod-secondary'));
  check('…a solo battle holds still while it asks, with no Paused under it', !host().running && !open('paused') && doc.activeElement === $('end-cancel'));
  esc();
  await tick(10);
  check('…Escape cancels and the battle picks up again', !confirm() && host().running && !open('paused'));
  $('pause').click();
  await tick(10);
  check('Pause opens the Paused modal, Resume focused, the nav\'s Pause hidden', open('paused') && doc.activeElement === $('resume') && doc.body.classList.contains('sim-paused')
    && /^\d\d:\d\d$/.test(text($('paused-clock'))));
  $('pause-end').click();
  await tick(10);
  check('…its End battle asks too, standing in for it', confirm() && !open('paused'));
  $('end-cancel').click();
  await tick(10);
  check('…Cancel gives the pause back, still paused', !confirm() && open('paused') && !host().running);
  esc();
  await tick(10);
  check('…and Escape resumes', !open('paused') && host().running);
  $('end').click();
  await tick(10);
  $('end-confirm').click();
  for (let i = 0; i < 40 && doc.body.dataset.screen !== 'debrief'; i++) await tick(25);
  check('End battle forfeits into the debrief', host().finished && host().finished.forfeit && doc.body.dataset.screen === 'debrief' && !confirm());

  // The debrief.
  const v = $('verdict');
  const art = !$('verdict-banner').classList.contains('hidden');
  check('the verdict: the game\'s banner, or the word led by its glyph — the word always there to be read', text(v) === 'Defeat'
    && (art ? v.classList.contains('sim-sr') && $('verdict-banner').matches('.raid-end-banner.sim-verdict-banner') : v.querySelector('i.sui-icon.sui-icon-md.icon-alert') && !v.classList.contains('sim-sr')));
  check('…the meta line in the app\'s words', /^\d\d:\d\d · \d+ blocks? · Difficult · Spearpoint$/.test(text($('debrief-meta'))), text($('debrief-meta')));
  const tal = $('tallies').closest('.sui-data-card');
  check('Tallies is a data card: its tag, the side tags, then one row per tally', tal && text(tal.querySelector('.sui-data-card-header')) === 'Tallies'
    && text(doc.querySelector('.sim-tally-h .sim-you')) === 'You' && text(doc.querySelector('.sim-tally-h .sim-cpu')) === 'Computer'
    && $('tallies').querySelectorAll(':scope > .sui-data-card-row.sim-tally').length === 6
    && $('tallies').querySelector('.sim-tally .sim-tally-l i.sui-icon.sui-icon-sm.icon-wreckage')
    && $('tallies').querySelector('.sim-tally .sim-tally-l i.sui-icon.sui-icon-sm.sui-icon-defender-block'));
  const mom = $('moments').closest('.sui-data-card');
  check('Turning points is the same card, with the Full battle log in it', mom && text(mom.querySelector('.sui-data-card-header')) === 'Turning points' && mom.contains($('show-log'))
    && $('show-log').classList.contains('sui-mod-secondary') && !doc.querySelector('.sim-debrief h2'));
  check('…its rows say Block, not B', [...$('moments').children].every((r) => !/^B\d/.test(text(r))) && $('moments').children.length > 0);
  check('the next moves: Rematch the one primary, the rest secondary and iconed, Harder\'s label in its span', $('db-rematch').classList.contains('sui-mod-primary')
    && ['db-edit', 'db-swap', 'db-harder', 'db-code'].every((id) => $(id).classList.contains('sui-mod-secondary') && $(id).parentNode.matches('.sim-next') && $(id).querySelector('i.sui-icon'))
    && text($('db-harder')) === 'Harder' && $('db-harder').querySelector('span') && $('db-edit').querySelector('i.icon-edit') && $('db-swap').querySelector('i.icon-transfers') && $('db-code').querySelector('i.icon-outgoing'));
  check('…New encounter is the game\'s frameless text control', $('db-new').matches('a.sui-nav-btn') && !doc.querySelector('.sim-link'));
  sw.Simulator.openLink('zzzz');
  await tick(10);
  check('the toast is the game\'s system alert, with no action slot', $('message').matches('.sui-message-system-alert.sui-mod-secondary') && /does not hold a battle/.test(text($('message')))
    && !$('message').querySelector('.sui-message-system-alert-close-container'));
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
  check('the sheet lists the rooms, and picks none for you', $('post-rooms').querySelectorAll('.sim-room').length === 2 && off($('post-send')) && !/Post to \S/.test(text($('post-send'))));
  {
    const dlg = $('post-dialog');
    check('…it is the game\'s system modal, in the scaled layout, named by its title', dlg && dlg.classList.contains('sui-message-system-model-overlay') && $('menu-page-layout').contains(dlg)
      && dlg.getAttribute('role') === 'dialog' && /Share battle/.test(text($(dlg.getAttribute('aria-labelledby'))))
      && dlg.querySelector('.sui-message-system-modal-frame-left-middle i.sui-icon.sui-icon-md.icon-outgoing'));
    const ctas = [...dlg.querySelectorAll('.sui-message-system-modal-cta-btn-wrapper > .sui-screen-btn')];
    check('…Copy link then Post, the one primary last; no close X', ctas.length === 2 && ctas[0].id === 'post-copy' && ctas[0].classList.contains('sui-mod-secondary')
      && ctas[1].id === 'post-send' && ctas[1].classList.contains('sui-mod-primary') && text(ctas[1]) === 'Post' && !dlg.querySelector('.sui-screen-nav-close'));
    check('…the find box is a SUI text field', $('post-find').closest('label.sui-input-text') && /Post to/.test(text($('post-find').closest('label.sui-input-text').querySelector('span'))));
    const rows = [...$('post-rooms').querySelectorAll('.sim-room')];
    check('…the rooms are radio result rows drawn as Comms draws a room', $('post-rooms').matches('.sui-result-table.sui-result-rows[role="radiogroup"]')
      && rows.every((r) => r.matches('.sui-result-row') && r.querySelector('.sui-radio-container input.sui-radio[name="post-room"]'))
      && rows[0].querySelector('.sui-result-row-portrait .chat-room-icon i.icon-guild') && rows[1].querySelector('.sui-result-row-portrait .pfp-frame')
      && /PID #1-61/.test(text(rows[1])) && !/direct|channel/.test(text($('post-rooms'))));
  }
  $('post-find').value = 'jp';
  $('post-find').dispatchEvent(new s.sw.Event('input'));
  check('…typing narrows it', $('post-rooms').querySelectorAll('.sim-room').length === 1);
  $('post-rooms').querySelector('.sim-room').click();
  check('…a click anywhere on the row picks it, and Post wakes', $('post-rooms').querySelector('input.sui-radio').checked && !off($('post-send')) && /^Post to /.test(text($('post-send'))));
  $('post-send').click();
  await tick(20);
  check('…and Post sends the battle code to that room, nothing else', posts.length === 1 && posts[0].roomId === '!b:h' && posts[0].guildId === '0-5' && posts[0].battle && posts[0].result == null);
  check('…then closes', !s.$('post-dialog'));
  $('import').click();
  check('Paste is the same modal: a Battle link field, Cancel and Load battle', $('code-dialog') && $('layout-code').closest('label.sui-input-text')
    && /Battle link/.test(text($('layout-code').closest('label'))) && text($('code-load')) === 'Load battle' && $('code-load').classList.contains('sui-mod-primary')
    && $('code-dialog').querySelector('.icon-incoming'));
  $('layout-code').value = 'nonsense';
  $('layout-code').dispatchEvent(new s.sw.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  check('…Enter loads, and a bad link says why while the dialog stays', $('code-dialog') && /link|battle/i.test(text($('message'))), text($('message')));
  s.sw.document.dispatchEvent(new s.sw.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  check('…Escape closes it', !$('code-dialog'));
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
  check('…a seat not ready says so as a warning badge, and the lobby is the phase badge', $('challenge').querySelector('.sim-seat .sui-badge.sui-mod-warning')
    && /Not ready/.test(text($('challenge').querySelector('.sim-run'))) && /^Lobby$/.test(text($('challenge').querySelector('.sim-settings .sui-badge'))));
  fire({ v: 1, kind: 'ready', ready: true });
  check('…the host\'s own ready shows on its seat', /Ready/.test(hostSeat()), hostSeat());
  fire({ v: 1, kind: 'start', battle, block_ms: 6000 });
  await tick(30);
  check('the host\'s start begins the battle here, the board replaying its ticks', s.sw.document.body.dataset.screen === 'battle' && s.sw.Simulator.getHost() instanceof s.sw.SimLive.RemoteHost);
  check('…with the Live chip, and no pause for a battle between two', /Live/.test(text($('sim-status'))) && s.sw.getComputedStyle($('pause')).display === 'none');
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
  check('…no rematch, edit or swap for a guest', $('db-rematch').classList.contains('hidden') && $('db-edit').classList.contains('hidden') && $('db-swap').classList.contains('hidden'));
  check('…so Share is the screen\'s one primary, and the result a primary system alert (P7)', $('db-code').classList.contains('sui-mod-primary') && !$('db-code').classList.contains('sui-mod-secondary')
    && $('db-post').matches('.sui-message-system-alert.sui-mod-primary') && $('db-post').querySelector('.sui-text-label.sui-text-primary'));
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
  check('…which opens a match by code, for that player, at 4 s blocks', opened.length === 1 && opened[0].toPlayer === '1-61' && opened[0].battle && opened[0].blockMs === 4000);
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
  // Who plays whom, one word per part (the parts are spaced by layout, not text).
  const versus = (row) => [...row.querySelector('.sc-versus-row').children].map((n) => text(n)).join(' ');
  const open = Card.inviteRow(v({}), { onAccept: () => {}, onWatch: () => {} });
  check('an open invite: anyone may Accept', Card.inviteState(v({})) === 'open' && [...open.querySelectorAll('.pc-act')].map((a) => a.title).join(',') === 'Accept');
  check('…addressed to you: For you', Card.inviteState(v({ frame: Object.assign({}, frame, { kind: 'invite', match: '!m:h', block_ms: 6000, to: [me] }) })) === 'for-you');
  check('…to someone else: no Accept', Card.inviteState(v({ frame: Object.assign({}, frame, { kind: 'invite', match: '!m:h', block_ms: 6000, to: ['@1-9:h'] }) })) === 'theirs');
  check('…your own: Waiting', Card.inviteState(v({ author: { name: 'You', self: true } })) === 'waiting');
  check('…untaken for a quarter hour: Lapsed', Card.inviteState(v({ ts: Date.now() - 16 * 60 * 1000 })) === 'lapsed');
  const liveRow = Card.inviteRow(v({ live: { state: 'live', guest_name: 'JPEG' } }), { onAccept: () => {}, onWatch: () => {} });
  check('playing: Live, the battle by name, who vs whom, and Watch', text(liveRow.querySelector('.pc-nm')) === 'Spearpoint' && versus(liveRow) === 'Marklifer vs JPEG'
    && text(liveRow.querySelector('.sui-badge')) === 'Live' && [...liveRow.querySelectorAll('.pc-act')].map((a) => a.title).join(',') === 'Watch'
    && liveRow.querySelector('.pc-act[title="Watch"] .icon-raid') && liveRow.querySelector('.gc-emblem i.icon-raid.sc-tone-enemy'));
  check('…block time is a reading, not caps prose', text(liveRow.querySelector('.pc-res')) === '6 s' && liveRow.querySelector('.pc-res i.icon-in-progress') && !/6 s/.test(text(liveRow.querySelector('.pc-id'))));
  const faces = Card.inviteRow(v({ author: { name: 'Marklifer', self: false, player_id: '1-1', pfp_attrs: null }, live: { state: 'live', guest_name: 'JPEG', guest_id: '1-61', guest_pfp: null } }), {});
  check('…with the chain\'s ids, both players are faces', faces.querySelectorAll('.sc-versus-row .pc-person').length === 2);
  const waiting = Card.inviteRow(v({ author: { name: 'You', self: true } }), {});
  check('…your own, untaken: "anyone may take it", the guest "anyone"', text(waiting.querySelector('.pc-id')) === 'anyone may take it' && versus(waiting) === 'You vs anyone');
  const ended = Card.inviteRow(v({ live: { state: 'ended', guest_name: 'JPEG', winner_name: 'JPEG' } }), {});
  check('over: who won, as a mark under who played', versus(ended) === 'Marklifer vs JPEG' && text(ended.querySelector('.pc-marks')) === 'JPEG'
    && ended.querySelector('.pc-marks i.icon-success') && !ended.querySelector('.pc-act[title="Accept"]'));
  const drawn = Card.inviteRow(v({ live: { state: 'ended', guest_name: 'JPEG' } }), {});
  check('…or a draw', text(drawn.querySelector('.pc-id')) === 'a draw' && drawn.querySelector('.pc-marks i.icon-subtract'));
}

console.log(failures ? failures + ' failing check(s)' : 'all checks passed');
process.exit(failures ? 1 : 0);
