// The Terminal card catalogue (frontend/structs-cards.js), on its own.
//
// Every data set the Terminal draws beyond players, guilds and providers, in
// its card, row and chip shapes, plus the readings they share: meter, health,
// progress, countdown, sparkline, versus, the tape line and the chip peek.
//
//   node scripts/harness-tests/structs-cards.test.mjs
import { JSDOM } from 'jsdom';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(resolve(repo, p), 'utf8');

let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? '  ok ' : 'FAIL ') + name + (ok || detail == null ? '' : ' — ' + detail));
  if (!ok) failures++;
}

const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' });
const w = dom.window;
w.eval(read('frontend/pfp.js'));
w.eval(read('frontend/playercard.js'));
w.eval(read('frontend/guildcard.js'));
w.eval(read('frontend/structs-cards.js'));
const C = w.StructsCards;
const d = w.document;
const text = (n) => (n ? n.textContent.replace(/\s+/g, ' ').trim() : '');
const click = (n) => n.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
const key = (n, k) => n.dispatchEvent(new w.KeyboardEvent('keydown', { key: k, bubbles: true }));

const OWNER = { id: '1-248', name: 'Phoniffer', tag: 'SN.C', pfp: '{"head":4,"neck":2,"body":1,"arms":3,"background":1}' };

{
  console.log('\n— the family shape');
  const kinds = ['planet', 'fleet', 'struct', 'substation', 'reactor', 'agreement', 'token', 'task', 'tx', 'raid', 'incident', 'loop', 'alert', 'asset', 'tape', 'workspace'];
  check('sixteen data sets are exported', kinds.every((k) => C[k]), kinds.filter((k) => !C[k]).join(','));
  const carded = ['planet', 'fleet', 'struct', 'substation', 'reactor', 'agreement', 'token', 'raid', 'loop', 'workspace'];
  check('the things with a face get a card', carded.every((k) => typeof C[k].card === 'function'));
  const listed = ['planet', 'fleet', 'struct', 'substation', 'reactor', 'agreement', 'token', 'task', 'tx', 'raid', 'incident', 'loop', 'alert', 'asset', 'tape'];
  check('everything that can be listed gets a row', listed.every((k) => typeof C[k].row === 'function'));
  check('everything gets a chip', kinds.every((k) => typeof C[k].chip === 'function'));
  check('queues have no card: a task and a transaction are rows and chips only', !C.task.card && !C.tx.card && !C.incident.card && !C.alert.card && !C.asset.card);
}

{
  console.log('\n— planet');
  let opened = 0, watched = 0, door = null;
  const card = C.planet.card({ id: '2-223', name: 'Kepler', shield: 25, ore: '4Kg', structs: '9 / 16', fleets: 2, owner: OWNER }, {
    onClick: () => opened++, onEmblem: () => watched++,
    doors: [{ icon: 'icon-combat-log', title: 'Battle log', onClick: () => { door = 'log'; } }, { icon: 'icon-close', title: 'Forget', destructive: true, onClick: () => { door = 'forget'; } }],
  });
  check('a card is the planet-card frame, typed by kind', card.classList.contains('sui-planet-card') && card.getAttribute('data-kind') === 'planet');
  check('the name leads, the id is bare', text(card.querySelector('.pc-nm')) === 'Kepler' && /#2-223/.test(text(card.querySelector('.pc-id'))));
  check('a shielded planet is live: teal stripe and a SHIELDED badge', card.classList.contains('sc-live') && text(card.querySelector('.sui-badge')) === 'SHIELDED');
  check('four readings, each with a glyph and a hover title, no captions', card.querySelectorAll('.pc-res').length === 4 && [...card.querySelectorAll('.pc-res')].every((r) => r.title && r.querySelector('i')) && !/shield|ore|structs/i.test(text(card.querySelector('.pc-reads'))));
  check('the owner is a person line in the footer', card.querySelector('.pc-foot .pc-person') !== null && /Phoniffer/.test(text(card.querySelector('.pc-foot'))));
  check('doors carry titles and the destructive one is drawn as such, last', [...card.querySelectorAll('.pc-act')].map((a) => a.title).join(',') === 'Battle log,Forget' && card.querySelector('.pc-act:last-child').classList.contains('sc-destructive'));
  click(card.querySelector('.pc-act[title="Battle log"]'));
  check('a door acts and does not open the body', door === 'log' && opened === 0);
  click(card.querySelector('.gc-emblem'));
  check('the emblem is the secondary act (watch), not the open', watched === 1 && opened === 0);
  click(card.querySelector('.pc-body') || card.querySelector('.sui-planet-card-body'));
  check('the body opens', opened === 1);
  key(card, 'Enter');
  check('Enter opens from the keyboard, the card is focusable', opened === 2 && card.tabIndex === 0);

  const raided = C.planet.card({ id: '2-1', shield: 0, raided: true, owner: OWNER });
  check('a raided planet is bad: red stripe, RAIDED', raided.classList.contains('sc-bad') && text(raided.querySelector('.sui-badge')) === 'RAIDED');
  const row = C.planet.row({ id: '2-223', name: 'Kepler', shield: 25, ore: '4Kg', owner: OWNER });
  check('the row keeps the owner as its third line', row.classList.contains('pc-row') && row.querySelector('.pc-ident .pc-person') !== null);
  const chip = C.planet.chip({ id: '2-223', name: 'Kepler', raided: true });
  check('the chip is name, id and the RAIDED badge', chip.classList.contains('sc-chip') && /Kepler/.test(text(chip)) && /2-223/.test(text(chip)) && /RAIDED/.test(text(chip)));
}

{
  console.log('\n— chips peek and select');
  let opened = 0;
  const host = d.createElement('div');
  const chip = C.fleet.chip({ id: '9-61', away: true }, { peek: () => C.fleet.card({ id: '9-61', away: true, structs: '8 / 16', owner: OWNER }), onClick: () => opened++ });
  host.appendChild(chip);
  click(chip);
  check('one click peeks: the full card opens in place under the chip', host.querySelector('.sc-peek .pc-card[data-kind="fleet"]') !== null && chip.classList.contains('is-open'));
  click(chip);
  check('a second click closes the peek', host.querySelector('.sc-peek') === null && !chip.classList.contains('is-open'));
  chip.dispatchEvent(new w.MouseEvent('dblclick', { bubbles: true }));
  check('double-click opens outright', opened === 1);
  click(chip); key(chip, 'Escape');
  check('Escape closes a peek', host.querySelector('.sc-peek') === null);
  check('an AWAY fleet chip wears the warning badge', /AWAY/.test(text(chip)));

  let sel = null;
  const row = C.struct.row({ id: '5-1', type: 'Tank', health: 5, maxHealth: 6, online: true, built: true }, { selectable: true, onSelect: (on) => { sel = on; } });
  click(row);
  check('a selectable row toggles selected on click', sel === true && row.classList.contains('is-selected'));
  key(row, ' ');
  check('Space toggles it back', sel === false && !row.classList.contains('is-selected'));
}

{
  console.log('\n— struct');
  const on = C.struct.card({ id: '5-1', type: 'Ore Extractor', ambit: 'space', location: '2-223', health: 6, maxHealth: 6, damage: 2, chargeToFire: 3, online: true, built: true, work: { icon: 'icon-in-progress', text: 'Mining · 42m', title: 'Work' }, owner: OWNER });
  check('the emblem is the struct type\'s art', on.querySelector('.gc-emblem img') !== null && /img\/structs\/extractor\/extractor-struct-base\.png$/.test(on.querySelector('.gc-emblem img').getAttribute('src')));
  check('ONLINE is the solid badge, the stripe is live', text(on.querySelector('.sui-badge')) === 'ONLINE' && on.classList.contains('sc-live'));
  check('health is the game\'s 10-chunk bar in the health colour, 6 of 6 filled', on.querySelectorAll('.sc-health .sui-action-bar-progress-bar-chunk').length === 10 && on.querySelectorAll('.sc-health .sui-mod-filled').length === 10);
  check('the work is a mark, not a caption', /Mining · 42m/.test(text(on.querySelector('.pc-marks'))));
  const hurt = C.struct.card({ id: '5-2', type: 'Tank', health: 2, maxHealth: 6, online: true, built: true });
  check('under 35% health the bar turns to the damage colour', hurt.querySelector('.sc-health').classList.contains('sc-bad') && hurt.querySelectorAll('.sc-health .sui-mod-filled').length === 3);
  const dead = C.struct.card({ id: '5-3', type: 'Tank', health: 0, maxHealth: 6, destroyed: true });
  check('destroyed: the wreckage glyph, DESTROYED, red stripe, empty bar', dead.querySelector('.gc-emblem i.icon-wreckage') !== null && text(dead.querySelector('.sui-badge')) === 'DESTROYED' && dead.classList.contains('sc-bad') && dead.querySelectorAll('.sc-health .sui-mod-filled').length === 0);
  const building = C.struct.row({ id: '5-4', type: 'Tank', built: false, building: { frac: 0.4, eta: '3m' } });
  check('building: BUILDING with the proof\'s progress bar as the mark', text(building.querySelector('.sui-badge')) === 'BUILDING' && building.querySelector('.pc-marks .sui-action-bar-progress-bar') !== null && building.querySelectorAll('.pc-marks .sui-mod-filled').length === 4);
}

{
  console.log('\n— substation and the meter');
  const fmt = (v) => v + 'W';
  const open = C.substation.card({ id: '4-4', load: 40, capacity: 100, fmt, connections: 12, perConnection: '5W', owner: OWNER });
  const m = open.querySelector('.sc-meter');
  check('the meter draws load over capacity with ticks at 80 and 90', m !== null && m.querySelector('.sc-meter-fill').style.width === '40%' && [...m.querySelectorAll('.sc-meter-tick')].map((t) => t.style.left).join(',') === '80%,90%');
  check('…with both readings printed through the caller\'s formatter', /40W/.test(text(m)) && /100W/.test(text(m)) && m.title === 'Load / capacity');
  check('under 80% the meter is plain and the badge is OPEN', !m.classList.contains('sc-warn') && text(open.querySelector('.sui-badge')) === 'OPEN');
  const thin = C.substation.card({ id: '4-5', load: 92, capacity: 100, fmt });
  check('over 90%: THIN, amber stripe, the meter goes amber', text(thin.querySelector('.sui-badge')) === 'THIN' && thin.classList.contains('sc-warn') && thin.querySelector('.sc-meter').classList.contains('sc-warn'));
  const full = C.meter(99, 100, fmt);
  check('at 95% the meter goes red', full.classList.contains('sc-bad'));
  const chip = C.substation.chip({ id: '4-5', load: 92, capacity: 100 });
  check('the chip says THIN too', /THIN/.test(text(chip)));
}

{
  console.log('\n— agreement, token, reactor');
  const a = C.agreement.card({ id: '11-3', side: 'bought', capacity: '10KW', rate: { value: '1', denomLabel: 'ack' }, left: { text: '3d 2h', frac: 0.6, title: '50,000 blocks left' }, counterparty: OWNER, providerChip: C.substation.chip({ id: '4-4', load: 1, capacity: 2 }) });
  check('BOUGHT badge, the countdown with the term as its bar and blocks in the title', text(a.querySelector('.sui-badge')) === 'BOUGHT' && a.querySelector('.sc-count') !== null && /3d 2h/.test(text(a.querySelector('.sc-count'))) && a.querySelector('.sc-count').title === '50,000 blocks left');
  // MILLIWATTS: the chain charges `duration × capacity × rate` with capacity
  // in mW, so a rate is per milliwatt. "per W" was a thousandfold error.
  check('the price reads per mW per block on its own wide line', /1 ack \/ mW \/ blk/.test(text(a.querySelector('.sc-wide'))), text(a.querySelector('.sc-wide')));
  check('the provider is a chip on the card', a.querySelector('.sc-chips .sc-chip[data-kind="substation"]') !== null);
  const ending = C.agreement.row({ id: '11-4', side: 'sold', capacity: '1KW', ending: true });
  check('SOLD is solid; an ending agreement is amber', text(ending.querySelector('.sui-badge')) === 'SOLD' && ending.classList.contains('sc-warn'));
  check('the agreement chip reads capacity and time left', /10KW · 3d 2h/.test(text(C.agreement.chip({ id: '11-3', side: 'bought', capacity: '10KW', left: { text: '3d 2h' } }))));

  const t = C.token.card({ guildId: '0-1', tag: 'SNC', name: 'SN Corp', denom: 'usnc', logo: 'img/logo-snc.gif', ratio: '1.003', collateral: '3.3Kg', supply: '2,489', history: [1, 1.001, 1.003] });
  check('the guild mark is the emblem, the ratio is the badge', t.querySelector('.gc-emblem img') !== null && text(t.querySelector('.sui-badge')) === '1.003');
  check('a ratio history draws as a sparkline', t.querySelector('svg.sc-spark polyline') !== null);
  const tc = C.token.chip({ guildId: '0-1', denom: 'usnc', ratio: '1.003' });
  check('the token chip is ratio, the alpha glyph, per denom', /1\.003/.test(text(tc)) && tc.querySelector('.sui-icon-alpha-matter') !== null && /\/ usnc/.test(text(tc)), text(tc));
  const r = C.reactor.card({ id: '3-1', fuel: '4.4Kg', capacity: '4.4KW', commission: 'Alpha', history: [1, 2, 3] });
  check('the reactor is drawn with its art and a capacity sparkline', r.querySelector('.gc-emblem img') !== null && r.querySelector('.sc-spark') !== null);
}

{
  console.log('\n— task and transaction rows');
  const running = C.task.row({ id: '5-12:mine', type: 'MINE', status: 'running', frac: 0.62, difficulty: 12, eta: '2m', structType: 'Ore Extractor' });
  check('a running task: RUNNING badge, live stripe, 6 of 10 chunks, the difficulty alone (no constant 64, no key glyph) in teal', text(running.querySelector('.sui-badge')) === 'RUNNING' && running.classList.contains('sc-live') && running.querySelectorAll('.sui-mod-filled').length === 6 && /\b12\b/.test(text(running)) && !/64/.test(text(running)) && running.querySelector('i.icon-key') === null && running.querySelector('.sc-ok') !== null);
  check('the status word is not repeated when the badge says it', !/running/.test(text(running.querySelector('.pc-id'))));
  const waiting = C.task.row({ id: '5-14:refine', type: 'REFINE', status: 'waiting', frac: 0, difficulty: null, eta: null });
  check('a waiting task says so on its id line, eta reads as a dash', /waiting/.test(text(waiting.querySelector('.pc-id'))) && /—/.test(text(waiting)));
  const hard = C.task.row({ id: '5-9:build', type: 'BUILD', status: 'waiting', frac: 0, difficulty: 40, eta: '9h' });
  check('a hard difficulty is drawn in the bad colour', hard.querySelector('.sc-bad-text') !== null);

  let op = null;
  const queued = C.tx.row({ id: 't2', type: 'StructBuildInitiate', signer: '1-194', position: 2, charge: 3, attempts: 2, retryLimit: 5, state: 'queued', eta: { text: '4 blk', frac: 0.5, title: '~21s' } }, {
    doors: [{ icon: 'icon-caret-up', title: 'Move up', onClick: () => { op = 'up'; } }, { icon: 'icon-close', title: 'Cancel', destructive: true, onClick: () => { op = 'cancel'; } }],
  });
  check('rank leads a queued transaction, retries are attention', text(queued.querySelector('.pc-prefix')) === '2.' && /try 2 \/ 5/.test(text(queued.querySelector('.pc-attn'))));
  check('the countdown is in blocks with seconds on hover', /4 blk/.test(text(queued.querySelector('.sc-count'))) && queued.querySelector('.sc-count').title === '~21s');
  click(queued.querySelector('.pc-act[title="Cancel"]'));
  check('cancel is a destructive door', op === 'cancel' && queued.querySelector('.pc-act[title="Cancel"]').classList.contains('sc-destructive'));
  const flight = C.tx.row({ id: 't1', type: 'PlayerSend', state: 'flight' });
  check('in flight: IN FLIGHT, live stripe, no doors, its own id when no signer is known', text(flight.querySelector('.sui-badge')) === 'IN FLIGHT' && flight.classList.contains('sc-live') && flight.querySelectorAll('.pc-act').length === 0 && /#t1/.test(text(flight.querySelector('.pc-id'))));
  const failed = C.tx.row({ id: 'h1', type: 'StructBuildInitiate', signer: '1-194', state: 'failed', error: 'insufficient charge', ago: '3m' });
  check('a failed result: FAILED, red stripe, the error as attention, and no emblem stealing the type\'s width', text(failed.querySelector('.sui-badge')) === 'FAILED' && failed.classList.contains('sc-bad') && /insufficient charge/.test(text(failed.querySelector('.pc-attn'))) && failed.querySelector('.gc-emblem') === null);
  const ok = C.tx.row({ id: 'h2', type: 'PlayerSend', signer: '1-194', state: 'ok', hash: 'ABCDEF0123456789', ago: '1m' });
  check('a success keeps the hash, shortened', text(ok.querySelector('.sui-badge')) === 'SUCCESS' && /ABCDEF01…/.test(text(ok.querySelector('.pc-id'))));
}

{
  console.log('\n— raid, incident');
  const live = C.raid.card({ planetId: '2-15361', planetName: 'Kepler', live: true, status: 'shields vulnerable', since: '30s', shield: 0, ore: '4Kg', shots: 3, attacker: { id: '1-194', name: 'Marklifer' }, defender: OWNER });
  check('a live raid: LIVE, red stripe, the enemy theme', text(live.querySelector('.sui-badge')) === 'LIVE' && live.classList.contains('sc-bad') && live.classList.contains('sc-enemy'));
  check('the status word survives on the id line', /shields vulnerable/.test(text(live.querySelector('.pc-id'))));
  const vs = live.querySelector('.sc-versus');
  check('attacker and defender stack, each behind the game\'s glyph', vs !== null && vs.querySelector('.sui-icon-attacker') !== null && vs.querySelector('.sui-icon-defending') !== null && vs.querySelectorAll('.pc-person').length === 2);
  const ended = C.raid.row({ planetId: '2-223', live: false, status: 'raid successful', since: '1h', ore: '1Kg', attacker: { id: '1-61' }, defender: OWNER });
  check('an ended raid row: the status as its badge, attacker vs defender on the third line', /RAID SUCCESSFUL/.test(text(ended.querySelector('.sui-badge'))) && ended.querySelector('.sc-versus-row') !== null && /vs/.test(text(ended.querySelector('.sc-versus-row'))) && !ended.classList.contains('sc-enemy'));
  check('the raid chip is planet + LIVE', /Kepler/.test(text(C.raid.chip({ planetId: '2-15361', planetName: 'Kepler', live: true }))) && /LIVE/.test(text(C.raid.chip({ planetId: '2-15361', live: true }))));

  const fired = C.incident.row({ at: '14:02', planetId: '2-287', mode: 'act', fired: 2, planned: 2, attacker: { id: '1-1957' }, damage: 4, fireTarget: '5-88' });
  check('an unnamed attacker is shown by id once', text(fired.querySelector('.sc-versus-row .pc-person')) === '1-1957', text(fired.querySelector('.sc-versus-row .pc-person')));
  check('an incident: mode as title, shots as badge, time as id, planet on the id line, attacker as a person', /act/.test(text(fired.querySelector('.pc-nm'))) && text(fired.querySelector('.sui-badge')) === '2 / 2' && /14:02/.test(text(fired.querySelector('.pc-id'))) && /2-287/.test(text(fired.querySelector('.pc-id'))) && /1-1957/.test(text(fired.querySelector('.sc-versus-row'))));
  const advised = C.incident.row({ at: '14:03', planetId: '2-287', mode: 'advise', fired: 0, planned: 3, advised: true });
  check('an advise-only incident says WILL NOT FIRE as attention, amber', /will not fire/.test(text(advised.querySelector('.pc-attn'))) && advised.classList.contains('sc-warn') && text(advised.querySelector('.sui-badge')) === '0 / 3');
}

{
  console.log('\n— loop, alert, asset');
  let toggled = null;
  const on = C.loop.card({ key: 'raid', name: 'Auto raid', on: true, cadence: '90s', lastScan: '12s', icon: 'icon-raid', figures: [{ value: '800', icon: 'sui-icon-players', title: 'Players swept' }], holding: 'no ore holders in reach' }, { onToggle: (v) => { toggled = v; } });
  check('a holding loop: HOLDING badge, amber, the reason as an attention mark', text(on.querySelector('.sui-badge')) === 'HOLDING' && on.classList.contains('sc-warn') && /no ore holders in reach/.test(text(on.querySelector('.pc-mark.pc-attn'))));
  const sw = on.querySelector('.sc-switch[data-loop="raid"] input');
  check('the footer is the game\'s own checkbox, checked', sw !== null && sw.checked === true && on.querySelector('.sui-checkbox-display') !== null);
  sw.checked = false; sw.dispatchEvent(new w.Event('change', { bubbles: true }));
  check('the switch reports the new state', toggled === false);
  check('the cadence is the id line', /every 90s/.test(text(on.querySelector('.pc-id'))));
  const off = C.loop.row({ key: 'build', name: 'Auto build', on: false });
  check('an off loop row: OFF, no stripe, the switch as its door', text(off.querySelector('.sui-badge')) === 'OFF' && !off.classList.contains('sc-live') && off.querySelector('.pc-actions .sc-switch') !== null);
  check('the loop chip says HOLDING', /HOLDING/.test(text(C.loop.chip({ name: 'Auto raid', on: true, holding: 'x' }))));

  const fired = C.alert.row({ text: 'raids.live >= 1', state: 'fired', value: 2, valueIcon: 'sui-icon-md icon-raid', firedAgo: '4m' });
  check('a fired alert: FIRED, red stripe, the reading beside it, fired-ago on the id line', text(fired.querySelector('.sui-badge')) === 'FIRED' && fired.classList.contains('sc-bad') && /2/.test(text(fired.querySelector('.pc-res'))) && /fired 4m/.test(text(fired.querySelector('.pc-id'))));
  check('a quiet alert is quiet; a bad rule is INVALID', text(C.alert.row({ text: 'x > 1', state: 'quiet', value: 0 }).querySelector('.sui-badge')) === 'QUIET' && text(C.alert.row({ text: 'nonsense', state: 'bad' }).querySelector('.sui-badge')) === 'INVALID');

  const ore = C.asset.row({ denom: 'ore', name: 'Ore', kind: 'ore', amount: '3g', sendable: false });
  check('ore: the ore glyph, the amount, not sendable as attention', ore.querySelector('.gc-emblem i.sui-icon-alpha-ore') !== null && /3g/.test(text(ore.querySelector('.pc-res'))) && /not sendable/.test(text(ore.querySelector('.pc-attn'))));
  const gt = C.asset.row({ denom: 'uguild.0-1', name: 'Hydro', tag: 'OH', kind: 'guild', amount: '12', worth: '12.04Kg' });
  check('a guild token shows its tag and its worth in alpha', /\[OH\]/.test(text(gt.querySelector('.pc-name'))) && gt.querySelectorAll('.pc-res').length === 2);
  check('the asset chip is the amount and the name', /12 Hydro/.test(text(C.asset.chip({ denom: 'uguild.0-1', name: 'Hydro', kind: 'guild', amount: '12' }))));
}

{
  console.log('\n— tape and workspace');
  const line = C.tape.row({ time: '14:02', kind: 'ore mine', kindTitle: 'struct_block_ore_mine_status', tone: 'default', subject: 'planet', ids: ['2-29604', '1-2655'], parts: ['amount 4 \u2192 5', C.planet.chip({ id: '2-223', name: 'Kepler' })], block: '4,200,719', fresh: true });
  check('a tape header is time, a SHORT kind badge (the full category on hover), the subject word and its ids, and the block', line.classList.contains('sc-tape') && text(line.querySelector('.sc-tape-t')) === '14:02' && text(line.querySelector('.sui-badge')) === 'ore mine' && line.querySelector('.sui-badge').title === 'struct_block_ore_mine_status' && /planet/.test(text(line.querySelector('.sc-tape-subj'))) && /2-29604/.test(text(line.querySelector('.sc-tape-subj'))) && /#4,200,719/.test(text(line.querySelector('.sc-tape-blk'))));
  check('the figures the frame carried get a band of their own, under the header', /amount 4 \u2192 5/.test(text(line.querySelector('.sc-tape-body'))) && line.querySelector('.sc-tape-body .sc-chip') !== null);
  const bare = C.tape.row({ time: '14:03', kind: 'block', subject: 'height', ids: [], parts: [] });
  check('a frame with no figures draws no second band', text(bare.querySelector('.sc-tape-body')) === '');
  check('the newest line wears the accent stripe', line.classList.contains('is-new'));

  /* jsdom evaluates neither container queries nor descendant cascade, so the
   * one-line-when-wide rule is pinned as text: a card wide enough puts the
   * figures on the header line instead of leaving the width beside the
   * timestamp empty, and it asks the CARD's width, not the viewport's. */
  {
    const css = read('frontend/structs-cards.css');
    const q = css.match(/@container tape \(min-width: [^)]+\) \{[\s\S]*?\n\}/);
    check('the tape measures its own card, not the window', /\.tm-tape \{[^}]*container-type: inline-size/.test(css) && /container-name: tape/.test(css));
    check('…and a wide card puts the figures on the header line, unwrapped, in a column that starts at the same x every line',
      q !== null && /\.sc-tape-body \{[^}]*grid-row: 1/.test(q[0]) && /\.sc-tape-body \{[^}]*flex-wrap: nowrap/.test(q[0])
      && /\.sc-tape \{ grid-template-columns: auto 46ch minmax\(0, 1fr\) auto/.test(q[0])
      && /\.sc-tape-blk \{ grid-column: 4/.test(q[0]), q && q[0]);
  }
  const ws = C.workspace.card({ name: 'trader', cards: ['market', 'book', 'banks'], open: true, windows: 1, changed: '2m' });
  check('a workspace card lists its cards as badges and says OPEN', ws.querySelectorAll('.sc-ws-cards .sui-badge').length === 3 && [...ws.querySelectorAll('.sui-badge')].some((b) => text(b) === 'OPEN'), ws.textContent);
}

{
  console.log('\n— the rules');
  const everything = d.createElement('div');
  everything.appendChild(C.planet.card({ id: '2-1', shield: 1, owner: OWNER }));
  everything.appendChild(C.tx.row({ id: 't', type: 'x', state: 'queued' }));
  everything.appendChild(C.raid.chip({ planetId: '2-1', live: true }, { onClick: () => {} }));
  everything.appendChild(C.raid.chip({ planetId: '2-2', live: false }));
  const words = ['Planet ID', 'Shield:', 'Health:', 'Status:'];
  check('no captions anywhere', words.every((s) => !everything.textContent.includes(s)));
  check('every handle is focusable; an inert chip (nothing to open) is plain text, not a fake control', [...everything.querySelectorAll('.sc-card, .sc-row, .sc-chip[href]')].every((n) => n.tabIndex === 0) && everything.querySelector('.sc-chip[data-id="2-2"]').tagName === 'SPAN');
  check('badges use only SUI mods', [...everything.querySelectorAll('.sui-badge')].every((b) => /sui-mod-(default|warning|destructive|solid)/.test(b.className)));
  const src = read('frontend/structs-cards.js');
  check('no emoji, no invented icon classes: glyphs are sui-icon-* or icon-* only', !/[\u{1F300}-\u{1FAFF}]/u.test(src) && !/glyph\('(?!icon-|sui-icon-)/.test(src));
}

{
  console.log('\n— art on disk');
  const { readdirSync } = await import('node:fs');
  const dirs = new Set(readdirSync(resolve(repo, 'frontend/img/structs')));
  const TYPES = ['Command Ship', 'Ore Extractor', 'Ore Refinery', 'Field Generator', 'High Altitude Interceptor', 'Jamming Satellite',
    'Orbital Shield Generator', 'Planetary Defense Cannon', 'SAM Launcher', 'Battleship', 'Cruiser', 'Destroyer', 'Frigate', 'Interceptor',
    'Mobile Artillery', 'Ore Bunker', 'Pursuit Fighter', 'Starfighter', 'Stealth Bomber', 'Submersible', 'Tank'];
  const missing = TYPES.filter((t) => !dirs.has(C.artSlug(t)));
  check('every real struct type resolves to an art directory that exists', missing.length === 0, missing.map((t) => t + '→' + C.artSlug(t)).join(', '));
}

console.log('');
if (failures) { console.log(failures + ' failing check(s)'); process.exit(1); }
console.log('all checks passed');
