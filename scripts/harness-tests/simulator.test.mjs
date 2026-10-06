// Battle Simulator checks.
//
//   node scripts/harness-tests/simulator.test.mjs
//
// 1. The chain engine against structsd's rules (each check names the Go it
//    pins: keeper/msg_server_struct_*.go, attack_context.go, struct_cache.go).
// 2. The computer player finishes whole battles with legal play.
// 3. The real Map Viewer (raidview.html, sim=1) driven through the host:
//    snapshot, actions, the animation queue, the battle log.
// 4. Animation coverage: every attack and counter the live catalogue allows
//    resolves to one of the game's animations.
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(resolve(repo, p), 'utf8');
let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? '  ok ' : 'FAIL ') + name + (ok || detail == null ? '' : ' — ' + detail));
  if (!ok) failures++;
}

const ctx = vm.createContext({ window: {}, console });
ctx.globalThis = ctx;
for (const f of ['simulator-types.js', 'simulator-chain.js', 'simulator-ai.js']) vm.runInContext(read('frontend/' + f), ctx);
const Chain = ctx.window.SimulatorChain, Ai = ctx.window.SimulatorAi, CATALOG = ctx.window.SimulatorTypes;
const T = CATALOG.types;
const byName = Object.fromEntries(T.map((t) => [t.type, t]));
const id = (name) => byName[name].id;

const ATTACK = '/structs.structs.MsgStructAttack';
function battle(structs, opts = {}) {
  return new Chain({
    types: T, seed: opts.seed || 'test', height: 1000,
    players: [{ id: '1-1', fleetId: '9-1', charge: opts.charge ?? 20 }, { id: '1-2', fleetId: '9-2', charge: opts.charge ?? 20 }],
    structs,
  });
}
const S = (sid, name, owner, ambit, slot = 0, protects = null) => ({ id: sid, typeId: id(name), owner, ambit, slot, protects });
const attack = (from, target, ws = 'primaryWeapon') => ({ '@type': ATTACK, operatingStructId: from, targetStructId: [target], weaponSystem: ws });
function run(chain, signer, msg) {
  chain.submit(signer, msg);
  const b = chain.produceBlock();
  return b.txs[b.txs.length - 1];
}
const shotsOf = (tx) => tx.events.find((e) => e.category === 'struct_attack').detail.eventAttackShotDetail;

/* ── 0. Catalogue ───────────────────────────────────────────────────────── */
check('catalogue comes from the chain LCD, with a height', /^https?:\/\//.test(CATALOG.lcd) && CATALOG.height > 0);
check('…all 22 struct types, 13 of them fleet', T.length === 22 && T.filter((t) => t.category === 'fleet').length === 13);
check('…live values, not genesis: Battleship carries a guided secondary and Signal Jamming',
  byName.Battleship.secondaryWeapon === 'guidedWeaponry' && byName.Battleship.unitDefenses === 'signalJamming');
check('…with the production cheatsheet copy merged in', byName.Battleship.primary_weapon_label === 'Mass Accelerator' && byName['Command Ship'].passive_weaponry_label === 'Chimera Counter');

/* ── 1. Charge (PlayerCache.GetCharge / Discharge) ──────────────────────── */
{
  const c = battle([S('5-1', 'Command Ship', '1-1', 'space'), S('5-2', 'Command Ship', '1-2', 'space')], { charge: 1 });
  const tx = run(c, '1-1', attack('5-1', '5-2'));
  check('an attack below its weapon charge is refused', !tx.ok && /insufficient charge/.test(tx.error), tx.error);
  check('…and a refused tx spends nothing', c.chargeOf('1-1') === 2);
  c.produceBlock();
  check('charge is blocks since the last action', c.chargeOf('1-1') === 3);
  const ok = run(c, '1-1', attack('5-1', '5-2'));
  check('at the cost the attack lands and discharges to zero', ok.ok && c.chargeOf('1-1') === 0, ok.error);
}
{
  const c = battle([S('5-1', 'Command Ship', '1-1', 'space'), S('5-2', 'Command Ship', '1-2', 'space'), S('5-3', 'Stealth Bomber', '1-1', 'air')]);
  c.submit('1-1', { '@type': '/structs.structs.MsgStructStealthActivate', structId: '5-3' });
  c.submit('1-1', attack('5-1', '5-2'));
  const b = c.produceBlock();
  check('a 0-charge stealth still discharges, so the next tx in the block cannot afford an attack',
    b.txs[0].ok && !b.txs[1].ok && /insufficient charge/.test(b.txs[1].error), JSON.stringify(b.txs.map((t) => t.error)));
}

/* ── 2. Defense (msg_server_struct_defense_*.go, struct_defender.go) ────── */
{
  const c = battle([S('5-1', 'Command Ship', '1-1', 'space'), S('5-2', 'Battleship', '1-1', 'space'), S('5-3', 'Starfighter', '1-1', 'space', 1), S('5-9', 'Command Ship', '1-2', 'space')]);
  const set = (d, p) => run(c, '1-1', { '@type': '/structs.structs.MsgStructDefenseSet', defenderStructId: d, protectedStructId: p });
  set('5-2', '5-1');
  const again = set('5-2', '5-1');
  check('setting the same defense again is a set, not a toggle', again.ok && c.get('5-2').protectedStructId === '5-1');
  set('5-2', '5-3');
  check('a defender guards ONE struct: a new target replaces the old', c.defendersOf('5-1').length === 0 && c.defendersOf('5-3')[0] === '5-2');
  check('self-defense is refused', /self_defense/.test(set('5-2', '5-2').error || ''));
  check('an enemy struct cannot be protected (IsProtecting: same location)', /not_in_range/.test(set('5-2', '5-9').error || ''));
  const clear = run(c, '1-1', { '@type': '/structs.structs.MsgStructDefenseClear', defenderStructId: '5-2' });
  check('clear removes the posture and costs the defend charge', clear.ok && !c.get('5-2').protectedStructId && c.chargeOf('1-1') === 0);
}
{
  // Guard 5-3 → 5-2; then 5-2 dies: its GUARD keeps the registration (only the
  // dead struct's own posture is cleared — DestroyStructDefender).
  const c = battle([S('5-1', 'Command Ship', '1-1', 'water'), S('5-2', 'Pursuit Fighter', '1-1', 'air', 0, '5-1'), S('5-3', 'Pursuit Fighter', '1-1', 'air', 1, '5-2'),
    S('5-8', 'Command Ship', '1-2', 'land'), S('5-9', 'Cruiser', '1-2', 'water')]);
  c.get('5-2').health = 1;
  c.get('5-3').status &= ~Chain.STATUS.ONLINE;                    // keep it out of the fight
  const tx = run(c, '1-2', attack('5-9', '5-2', 'secondaryWeapon'));
  check('a destroyed defender loses its own posture', tx.ok && c.get('5-2') && !c.get('5-2').protectedStructId, tx.error);
  check('…but a struct guarding the destroyed one keeps its registration', c.get('5-3').protectedStructId === '5-2');
}

/* ── 3. Attack resolution (attack_context.go) ───────────────────────────── */
{
  const c = battle([S('5-1', 'Command Ship', '1-1', 'space'), S('5-8', 'Command Ship', '1-2', 'space'), S('5-9', 'Battleship', '1-2', 'space', 0, '5-8')]);
  const shot = shotsOf(run(c, '1-1', attack('5-1', '5-8')))[0];
  const counter = shot.eventAttackDefenderCounterDetail[0];
  check('a defender counters first, from the weapon that reaches', counter.counterByStructId === '5-9' && counter.counterByStructWeaponSystem === 'secondaryWeapon');
  check('…then blocks in the target\'s ambit and takes the volley', shot.blocked && shot.blockedByStructId === '5-9' && shot.blockerHealthAfter === 1 && shot.targetHealthAfter === 6);
  check('…and the surviving target counters after it', shot.targetCountered && shot.targetCounteredDamage === 2 && c.get('5-1').health === 3);
}
{
  // Defender in ANOTHER ambit: counters if its weapons reach, never blocks.
  const c = battle([S('5-1', 'Command Ship', '1-1', 'land'), S('5-8', 'Command Ship', '1-2', 'land'), S('5-9', 'Battleship', '1-2', 'space', 0, '5-8')]);
  const shot = shotsOf(run(c, '1-1', attack('5-1', '5-8')))[0];
  check('an off-ambit defender counters but cannot block', shot.eventAttackDefenderCounterDetail.length === 1 && !shot.blocked && shot.targetHealthAfter === 4);
}
{
  // Counters destroying the attacker void the volley and any block.
  const c = battle([S('5-1', 'Command Ship', '1-1', 'space'), S('5-8', 'Command Ship', '1-2', 'space'), S('5-9', 'Battleship', '1-2', 'space', 0, '5-8')]);
  c.get('5-1').health = 1;
  const tx = run(c, '1-1', attack('5-1', '5-8'));
  const shot = shotsOf(tx)[0];
  check('an attacker killed by a counter fires nothing and nothing blocks', !shot.blocked && shot.targetHealthAfter === 6 && c.get('5-9').health === 3);
  const raid = tx.events.find((e) => e.category === 'raid_status');
  check('…its Command Ship\'s destruction defeats its fleet (away from home)', raid && raid.detail.status === 'attackerDefeated' && raid.detail.fleet_id === '9-1');
  check('…emitted before the attack event, as the chain does', tx.events.indexOf(raid) < tx.events.findIndex((e) => e.category === 'struct_attack'));
  check('…and the defeated fleet leaves: nothing of it is reachable', !c.fleets['9-1'].atBattle && c.fleetsAtBattle().join() === '9-2');
}
{
  // Evasion: one roll per target on the TARGET owner's nonce; evaded skips the
  // block but not the defender counters.
  let evaded = 0, n = 0, counteredWhileEvaded = 0;
  for (let i = 0; i < 300; i++) {
    const c = battle([S('5-1', 'Starfighter', '1-1', 'space'), S('5-2', 'Command Ship', '1-1', 'water'),
      S('5-7', 'Command Ship', '1-2', 'water'), S('5-8', 'Battleship', '1-2', 'space'), S('5-9', 'Frigate', '1-2', 'space', 1, '5-8')], { seed: 's' + i });
    const shot = shotsOf(run(c, '1-1', attack('5-1', '5-8')))[0];
    n++;
    if (shot.evaded) { evaded++; if (shot.eventAttackDefenderCounterDetail.length && !shot.blocked) counteredWhileEvaded++; }
  }
  const rate = evaded / n;
  check('Signal Jamming evades guided fire at the chain\'s 2/3', rate > 0.58 && rate < 0.75, rate.toFixed(3));
  check('…an evaded shot is never blocked, and defenders still counter it', counteredWhileEvaded === evaded);
}
{
  const c = battle([S('5-1', 'Mobile Artillery', '1-1', 'land'), S('5-2', 'Command Ship', '1-1', 'space'), S('5-8', 'Tank', '1-2', 'land'), S('5-9', 'Command Ship', '1-2', 'space')]);
  const shot = shotsOf(run(c, '1-1', attack('5-1', '5-8')))[0];
  check('armour: a 2-damage round against a Tank deals 1', shot.damage === 1 && shot.damageReduction === 1 && c.get('5-8').health === 2);
  check('indirect combat: Mobile Artillery is never countered', !shot.targetCountered && c.get('5-1').health === 3);
  const p = battle([S('5-1', 'Battleship', '1-1', 'space'), S('5-2', 'Command Ship', '1-1', 'space'), S('5-8', 'Tank', '1-2', 'land'), S('5-9', 'Command Ship', '1-2', 'space')]);
  const ps = shotsOf(run(p, '1-1', attack('5-1', '5-8')))[0];
  check('armour piercing ignores the reduction', ps.armourPiercing === true && p.get('5-8').health === 1);
}
{
  // Multi-shot weapons: EndShot writes n-1 projectile rows, then the aggregate.
  const st = byName.Starfighter;
  const c = battle([S('5-1', 'Starfighter', '1-1', 'space'), S('5-2', 'Command Ship', '1-1', 'water'), S('5-8', 'Command Ship', '1-2', 'space')]);
  const rows = shotsOf(run(c, '1-1', attack('5-1', '5-8', 'secondaryWeapon')));
  const n = st.secondaryWeaponShots;
  check('an attack run writes one row per projectile', rows.length === n, rows.length + ' rows for ' + n + ' shots');
  check('…intermediate rows carry no outcome, the last carries the volley', rows.slice(0, -1).every((r) => r.damage === 0 && r.targetHealthAfter === r.targetHealthBefore && r.eventAttackDefenderCounterDetail === null)
    && rows[n - 1].targetHealthAfter === c.get('5-8').health);
}
{
  const c = battle([S('5-1', 'Command Ship', '1-1', 'water'), S('5-3', 'Submersible', '1-1', 'water', 0), S('5-8', 'Command Ship', '1-2', 'water'), S('5-9', 'Submersible', '1-2', 'water', 0), S('5-10', 'Frigate', '1-2', 'space')]);
  run(c, '1-1', { '@type': '/structs.structs.MsgStructStealthActivate', structId: '5-3' });
  check('stealth hides a struct from other ambits', c.canAttack(c.get('5-10'), c.get('5-3'), 'primaryWeapon') === 'hidden' || c.canAttack(c.get('5-10'), c.get('5-3'), 'primaryWeapon') === 'out_of_range');
  check('…but not from its own ambit', c.canAttack(c.get('5-9'), c.get('5-3'), 'primaryWeapon') === null);
  c.produceBlock(); c.produceBlock(); c.produceBlock(); c.produceBlock(); c.produceBlock();
  run(c, '1-1', attack('5-3', '5-8'));
  check('attacking drops the attacker out of stealth', !c.isHidden(c.get('5-3')));
  const noStealth = run(c, '1-2', { '@type': '/structs.structs.MsgStructStealthActivate', structId: '5-10' });
  check('stealth is gated on unitDefenses = stealthMode', !noStealth.ok && /no stealth/.test(noStealth.error));
}
{
  const c = battle([S('5-1', 'Command Ship', '1-1', 'space'), S('5-2', 'Tank', '1-1', 'land'), S('5-8', 'Command Ship', '1-2', 'space')]);
  const mv = run(c, '1-1', { '@type': '/structs.structs.MsgStructMove', structId: '5-1', locationType: 'fleet', ambit: 'water', slot: 0 });
  check('the Command Ship moves ambit for its move charge', mv.ok && c.get('5-1').ambit === 'water' && mv.events.some((e) => e.category === 'struct_move'));
  c.produceBlock(); c.produceBlock(); c.produceBlock();
  const imm = run(c, '1-1', { '@type': '/structs.structs.MsgStructMove', structId: '5-2', locationType: 'fleet', ambit: 'land', slot: 1 });
  check('other fleet hulls are immovable', !imm.ok && /immovable/.test(imm.error));
  const off = run(c, '1-1', { '@type': '/structs.structs.MsgStructDeactivate', structId: '5-2' });
  check('deactivation costs no charge', off.ok && c.chargeOf('1-1') === c.height - c.players['1-1'].lastAction && !c.isOnline(c.get('5-2')));
  const on = run(c, '1-1', { '@type': '/structs.structs.MsgStructActivate', structId: '5-2' });
  check('activation costs its charge and fits the grid it came from', on.ok || /insufficient charge/.test(on.error), on.error);
}
{
  // Sweep: destroyed structs leave the map StructSweepDelay blocks later.
  const c = battle([S('5-1', 'Command Ship', '1-1', 'space'), S('5-2', 'Battleship', '1-1', 'space'), S('5-8', 'Command Ship', '1-2', 'space'), S('5-9', 'Frigate', '1-2', 'space')]);
  c.get('5-9').health = 1;
  run(c, '1-1', attack('5-2', '5-9', 'secondaryWeapon'));
  const at = c.height;
  while (c.height < at + Chain.STRUCT_SWEEP_DELAY - 1) c.produceBlock();
  check('a wreck stays until the sweep', !!c.get('5-9'));
  c.produceBlock();
  check('…and is swept ' + Chain.STRUCT_SWEEP_DELAY + ' blocks after destruction', !c.get('5-9'));
}
{
  // A failed tx reverts entirely — including the randomness nonce.
  const c = battle([S('5-1', 'Command Ship', '1-1', 'space'), S('5-8', 'Command Ship', '1-2', 'land')]);
  const before = JSON.stringify(c.players);
  const tx = run(c, '1-1', attack('5-1', '5-8'));
  check('an out-of-range attack fails and changes nothing', !tx.ok && /out_of_range/.test(tx.error) && JSON.stringify(c.players) === before);
}

/* ── 2b. The computer player ────────────────────────────────────────────── */
{
  const layoutOf = (seed) => {
    const fleet = T.filter((t) => t.category === 'fleet' && t.type !== 'Command Ship');
    const out = []; let n = 1;
    for (const [owner, base] of [['1-1', 1000], ['1-2', 2000]]) {
      out.push(S('5-' + (base + n++), 'Command Ship', owner, 'space'));
      ['space', 'air', 'land', 'water'].forEach((ambit) => {
        fleet.filter((t) => t.possibleAmbit & Chain.AMBIT_FLAG[ambit]).slice(0, 2).forEach((t, slot) => out.push({ id: '5-' + (base + n++), typeId: t.id, owner, ambit, slot }));
      });
    }
    return out;
  };
  let finished = 0, refused = 0, sent = 0;
  for (const [a, b] of [['hard', 'easy'], ['difficult', 'difficult'], ['easy', 'hard']]) {
    const c = new Chain({ types: T, seed: a + b, height: 5000, players: [{ id: '1-1', fleetId: '9-1', charge: 9 }, { id: '1-2', fleetId: '9-2', charge: 9 }], structs: layoutOf(a + b) });
    const ais = [new Ai('1-1', a, 'x'), new Ai('1-2', b, 'y')];
    for (let i = 0; i < 400 && c.fleetsAtBattle().length === 2; i++) {
      ais.forEach((ai) => { const m = ai.decide(c); if (m) { c.submit(ai.pid, m); sent++; } });
      // Two signers in one block race: a struct the other side destroyed
      // earlier in the block is a refusal the chain itself would give.
      c.produceBlock().txs.forEach((t) => { if (!t.ok && !/destroyed|unreachable/.test(t.error)) refused++; });
    }
    if (c.fleetsAtBattle().length < 2) finished++;
  }
  check('computer players finish whole battles at every difficulty', finished === 3, finished + '/3');
  check('…sending only messages it can afford and that are legal', refused === 0, refused + ' of ' + sent + ' refused');
}

/* ── 2b. Stalemates: the host calls a draw the chain never would ────────── */
{
  ctx.window.addEventListener = () => {}; ctx.window.removeEventListener = () => {};
  ctx.window.location = { origin: '' };
  Object.assign(ctx, { setTimeout, clearTimeout, Date });
  if (!ctx.window.SimulatorHost) vm.runInContext(read('frontend/simulator-host.js'), ctx);
  const Host = ctx.window.SimulatorHost;
  const host = (structs) => {
    const h = new Host({ chain: battle(structs, { charge: 0 }), you: { id: '1-1', name: 'You' }, cpu: { id: '1-2', name: 'Computer' }, frame: () => null });
    h.scheduleBlock = () => {}; h.scheduleAi = () => {}; h.running = true;
    return h;
  };
  // Two Command Ships in different ambits, nobody acting: quiet blocks.
  const q = host([S('5-1', 'Command Ship', '1-1', 'space'), S('5-2', 'Command Ship', '1-2', 'water')]);
  let n = 0;
  while (!q.finished && n < 500) { q.block(); n++; }
  check('nobody hitting anybody for ' + Host.QUIET_BLOCKS + ' blocks is a draw', q.finished && q.finished.winner === 'draw' && q.finished.stalemate === 'quiet' && n === Host.QUIET_BLOCKS, JSON.stringify(q.finished) + ' after ' + n);

  // A Command Ship shuffling between ambits with no hit landing: quiet moves.
  const m = host([S('5-1', 'Command Ship', '1-1', 'space'), S('5-2', 'Command Ship', '1-2', 'water')]);
  const AMB = ['air', 'land', 'space', 'land'];
  let moves = 0;
  for (let i = 0; i < 80 && !m.finished; i++) {
    if (i % 4 === 3) { m.chain.submit('1-1', { '@type': '/structs.structs.MsgStructMove', structId: '5-1', locationType: 'fleet', ambit: AMB[moves % 4], slot: 0 }); moves++; }
    m.block();
  }
  check('…and so are ' + Host.QUIET_MOVES + ' Command Ship moves without a hit', m.finished && m.finished.stalemate === 'moves' && m.quietMoves === Host.QUIET_MOVES, JSON.stringify(m.finished) + ' moves=' + moves + ' quiet=' + m.quietMoves);

  // Any damage resets the count.
  const d = host([S('5-1', 'Command Ship', '1-1', 'space'), S('5-3', 'Starfighter', '1-1', 'space'), S('5-2', 'Command Ship', '1-2', 'space')]);
  for (let i = 0; i < 6; i++) d.block();
  d.chain.submit('1-1', attack('5-3', '5-2'));
  d.block();
  check('…a landed hit restarts the clock', !d.finished && d.lastHurt === d.chain.height, 'lastHurt=' + d.lastHurt + ' height=' + d.chain.height);
}

/* ── 3. The real Map Viewer, driven through the host ────────────────────── */
{
  const page = resolve(repo, 'frontend/raidview.html');
  let host;
  const subs = {};
  const dom = await JSDOM.fromFile(page, {
    url: pathToFileURL(page).href + '?planet=2-1&label=sim&sim=1',
    runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true,
    beforeParse(w) {
      w.HTMLCanvasElement.prototype.getContext = () => ({ fillStyle: null, fillRect() {}, drawImage() {}, getImageData: () => ({ data: [] }), measureText: () => ({ width: 0 }) });
      for (const f of ['simulator-types.js', 'simulator-chain.js', 'simulator-ai.js', 'simulator-host.js']) w.eval(read('frontend/' + f));
      const chain = new w.SimulatorChain({ types: w.SimulatorTypes.types, seed: 'dom', height: 7000, players: [{ id: '1-1', fleetId: '9-1', charge: 9 }, { id: '1-2', fleetId: '9-2', charge: 9 }],
        structs: [S('5-1001', 'Command Ship', '1-1', 'space'), S('5-1002', 'Battleship', '1-1', 'space'), S('5-1003', 'Tank', '1-1', 'land'),
          S('5-2001', 'Command Ship', '1-2', 'space'), S('5-2002', 'Frigate', '1-2', 'space', 0, '5-2001'), S('5-2003', 'Cruiser', '1-2', 'water')] });
      host = new w.SimulatorHost({ chain, you: { id: '1-1', name: 'You', pfp: null }, cpu: { id: '1-2', name: 'Computer', pfp: null }, label: 'sim', frame: () => null });
      host.post = (m) => (subs[m.name] || []).forEach((cb) => cb({ payload: m.payload }));
      w.__TAURI__ = {
        // In the app the host's window and the board's frame are different
        // windows; here they are one, so the app's own sound reads are
        // answered by the stub rather than forwarded back into the host.
        core: { invoke: (cmd, args) => Promise.resolve().then(() => (/^sound_/.test(cmd) ? null : host.invoke(cmd, args))) },
        event: { listen: (name, cb) => { (subs[name] = subs[name] || []).push(cb); return Promise.resolve(() => {}); } },
      };
    },
  });
  const w = dom.window;
  const until = async (fn, ms = 5000) => { const t0 = Date.now(); for (;;) { const v = fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await new Promise((r) => setTimeout(r, 50)); } };
  await until(() => w.RaidView && Object.keys(w.RaidView._state.structsById).length === 6);
  const RV = w.RaidView;
  check('the Map Viewer boots from the host and seats every struct', Object.keys(RV._state.structsById).length === 6 && !/no free tile/.test(w.document.getElementById('rv-note').textContent));
  check('…without a planetary block, all four ambits drawn', !Object.keys(RV._anchors()).some((k) => k.startsWith('plan|')) && ['space', 'air', 'land', 'water'].every((a) => RV._anchors()['cmd|defender|' + a]));
  check('…sim mode hides Comms and the planet panel', w.document.documentElement.hasAttribute('data-sim')
    && w.getComputedStyle(w.document.getElementById('rv-chat')).display === 'none');
  check('…you control your own fleet only', RV._state.controlled['1-1'] === true && !RV._state.controlled['1-2']);
  check('…charge comes from the chain clock', RV._chargeOfPlayer('1-1') === host.displayCharge('1-1') && RV._state.height === 7000);

  host.running = true; host.lastTick = Date.now();
  const text = await host.invoke('mcp_struct_act', { player: '1-1', action: 'attack', args: { attacker_id: '5-1002', target_id: '5-2001', weapon: 'secondary' } });
  check('an action answers like the façade: "submitted — tx <hash>"', /submitted — tx [0-9A-F]{16,}/.test(text) && !RV.actTextIsFailure(text), text);
  await Promise.resolve().then(() => host.invoke('mcp_struct_act', { player: '1-2', action: 'attack', args: {} })).then(() => check('the other side\'s key is not yours', false), (e) => check('the other side\'s key is not yours', /no key/.test(String(e))));
  host.scheduleBlock = () => {}; host.scheduleAi = () => {};
  host.block();
  await until(() => RV._playing() || RV._queue().length);
  check('the block\'s attack runs through planAttack into the animation queue', RV._playing() === true);
  const plan = RV.planAttack({ attacker_id: '5-1002', weapon: 'secondaryWeapon', attacker_type: 'Battleship', attacker_ambit: 'space', attacker_health_before: 3, attacker_health_after: host.chain.get('5-1002').health,
    shots: host.lastBlock.events.find((e) => e.category === 'struct_attack').detail.eventAttackShotDetail }, RV._state.structsById);
  const flat = plan.map((e) => e.structId + ':' + e.names.join('+'));
  check('…counter by the guard, the Battleship\'s missile, impact on the BLOCKER, then the target\'s counter',
    flat[0].startsWith('5-2002:ATTACK_') && flat.some((x) => x === '5-1002:ATTACK_SECONDARY_WEAPON') && flat.some((x) => x.startsWith('5-2002:IMPACT_')) && !flat.some((x) => x.startsWith('5-2001:IMPACT_')), flat.join(' | '));
  check('the battle log gets the live renderer\'s rows', host.logRows.some((r) => r.category === 'struct_attack' && /Battleship 5-1002 → Command Ship 5-2001/.test(r.detail)));
  const refused = await host.invoke('mcp_struct_act', { player: '1-1', action: 'attack', args: { attacker_id: '5-1003', target_id: '5-2002', weapon: 'primary' } });
  const failedTx = [];
  subs['raid-tx::sim'] = (subs['raid-tx::sim'] || []).concat([(e) => failedTx.push(e.payload)]);
  host.block();
  check('a tx the chain refuses comes back as a failed raid-tx', failedTx.length === 1 && failedTx[0].status === 'failed' && /charge|out_of_range/.test(failedTx[0].error) && refused.includes('submitted'), JSON.stringify(failedTx));
  const asked = [];
  const realInvoke = host.invoke.bind(host);
  const prev = w.__TAURI__; w.__TAURI__ = { core: { invoke: (c) => { asked.push(c); return Promise.resolve(null); } } };
  await Promise.resolve(realInvoke('sound_config_get', {}));
  const refusedCmd = await Promise.resolve().then(() => realInvoke('mcp_inventory', {})).then(() => null, (e) => String(e));
  w.__TAURI__ = prev;
  check('only the sound reads reach the app; everything else is refused locally', asked.join() === 'sound_config_get' && /not part of the simulator/.test(refusedCmd || ''), asked.join() + ' / ' + refusedCmd);
  host.destroy();
  dom.window.close();

  /* ── 4. Animation coverage ─────────────────────────────────────────────── */
  const fleet = T.filter((t) => t.category === 'fleet');
  const AMB = ['space', 'air', 'land', 'water'];
  const missing = [];
  for (const t of fleet) {
    for (const ws of ['primaryWeapon', 'secondaryWeapon']) {
      if (Chain.weaponField(t, ws, '') === 'noActiveWeaponry') continue;
      for (const from of AMB.filter((a) => t.possibleAmbit & Chain.AMBIT_FLAG[a])) {
        for (const to of AMB.filter((a) => Chain.canTargetAmbit(t, ws, from, a))) {
          if (!RV.resolveShotAnimation(t.type, from, to, ws, 1, false, '')) missing.push(t.type + ' ' + ws + ' ' + from + '→' + to);
        }
      }
    }
  }
  check('every attack the live catalogue allows has the game\'s animation', missing.length === 0, missing.join(', '));
  const evades = [...new Set(fleet.map((t) => t.unitDefenses))].filter((d) => /signalJamming|defensiveManeuver/.test(d));
  check('…and every unit evasion its art', evades.every((d) => RV.EVADE_ART[d]), evades.join());
}

console.log(failures ? failures + ' failing check(s)' : 'all checks passed');
process.exit(failures ? 1 : 0);
