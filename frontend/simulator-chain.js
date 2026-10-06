/* A local structsd: the struct combat messages, executed the way the chain
 * executes them, block by block.
 *
 * Every rule below is a transcription of structsd (../structs/x/structs) and
 * names the function it came from. Nothing is simplified for play. Two fleets
 * meet AWAY from both home planets — the one deliberate difference from a live
 * raid — so there is no planetary struct, no planetary defense cannon, no
 * jamming-satellite interception, and a destroyed Command Ship always defeats
 * its fleet (StructCache.CanTriggerRaidDefeatByDestruction: "not at home").
 *
 * Transactions queue in a mempool and run at the next block, in the order they
 * were sent. A message that fails reverts entirely, as a Cosmos tx does.
 * Events come out in the order the chain emits them: typed events as they
 * happen (defense set/clear, raid status, the attack at Finalize), then the
 * attribute frames the indexer derives at commit (health, status, move).
 */
(function (root) {
  'use strict';

  // types/keys.go — STRUCT_STATUS_FLAGS and Ambit_flag.
  var STATUS = { MATERIALIZED: 1, BUILT: 2, ONLINE: 4, STORED: 8, HIDDEN: 16, DESTROYED: 32, LOCKED: 64 };
  var AMBIT_FLAG = { water: 2, land: 4, air: 8, space: 16, local: 32 };
  var AMBITS = ['space', 'air', 'land', 'water'];
  var STRUCT_SWEEP_DELAY = 5;                 // types/keys.go StructSweepDelay
  var WEAPON_SYSTEMS = ['primaryWeapon', 'secondaryWeapon'];
  var COMMAND_STRUCT = 'Command Ship';         // types.CommandStruct

  function ChainError(code, message) { var e = new Error(message); e.code = code; return e; }

  /* StructCache.IsSuccessful: a fresh math/rand source seeded with the block's
   * AppHash plus the owner's incremented nonce, then Intn(den) + 1 <= num.
   * The AppHash is not ours to have, so the block seed is derived from the
   * battle seed and the height; the shape of the draw is the chain's. */
  function hash32(str) {
    var h = 2166136261 >>> 0;
    for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return h >>> 0;
  }
  function mulberry(a) {
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function Chain(opts) {
    opts = opts || {};
    this.types = {};
    (opts.types || []).forEach(function (t) { this.types[t.id] = t; }, this);
    this.seed = String(opts.seed == null ? '' : opts.seed);
    this.height = opts.height || 1;
    this.planetId = opts.planetId || '2-1';
    this.players = {};
    this.fleets = {};
    this.structs = {};
    this.defenders = {};            // protectedStructId → { defenderStructId: true }
    this.destructionQueue = {};     // height → [structId]
    this.mempool = [];
    this.txSeq = 0;
    var self = this;
    (opts.players || []).forEach(function (p) {
      self.players[p.id] = {
        id: p.id, name: p.name || p.id, fleetId: p.fleetId, nonce: 0,
        // Charge is blocks since the last action (PlayerCache.GetCharge).
        lastAction: self.height - (p.charge == null ? 0 : p.charge),
        capacity: 0, load: 0,
      };
      self.fleets[p.fleetId] = { id: p.fleetId, owner: p.id, atBattle: true, commandStruct: null, home: p.homePlanetId || null };
    });
    (opts.structs || []).forEach(function (s) {
      var t = self.types[s.typeId];
      if (!t) throw ChainError('unknown_type', 'unknown struct type ' + s.typeId);
      var owner = self.players[s.owner];
      self.structs[s.id] = {
        id: s.id, typeId: t.id, owner: s.owner, locationType: 'fleet', locationId: owner.fleetId,
        ambit: s.ambit, slot: t.type === COMMAND_STRUCT ? 0 : s.slot,
        health: t.maxHealth, status: STATUS.MATERIALIZED | STATUS.BUILT | STATUS.ONLINE,
        protectedStructId: null, destroyedAt: null,
      };
      owner.load += t.passiveDraw || 0;
      if (t.type === COMMAND_STRUCT) self.fleets[owner.fleetId].commandStruct = s.id;
    });
    // Every struct is online, so the grid already carries them; capacity is
    // what they draw, which is what lets a deactivated struct come back
    // (ActivationReadinessCheck → CanSupportLoadAddition).
    Object.keys(this.players).forEach(function (pid) { self.players[pid].capacity = self.players[pid].load; });
    (opts.structs || []).forEach(function (s) { if (s.protects) self.setDefender(s.protects, s.id, null); });
  }

  Chain.STATUS = STATUS;
  Chain.AMBIT_FLAG = AMBIT_FLAG;
  Chain.AMBITS = AMBITS;
  Chain.STRUCT_SWEEP_DELAY = STRUCT_SWEEP_DELAY;

  /* ── Reads ─────────────────────────────────────────────────────────────── */

  Chain.prototype.typeOf = function (s) { return this.types[s.typeId]; };
  Chain.prototype.get = function (id) { return this.structs[id] || null; };
  Chain.prototype.isDestroyed = function (s) { return (s.status & STATUS.DESTROYED) !== 0; };
  Chain.prototype.isOnline = function (s) { return (s.status & STATUS.ONLINE) !== 0; };
  Chain.prototype.isBuilt = function (s) { return (s.status & STATUS.BUILT) !== 0; };
  Chain.prototype.isHidden = function (s) { return (s.status & STATUS.HIDDEN) !== 0; };
  /* PlayerCache.GetCharge at the block being executed. */
  Chain.prototype.chargeOf = function (pid, atHeight) {
    var p = this.players[pid];
    return p ? (atHeight == null ? this.height : atHeight) - p.lastAction : 0;
  };
  /* GetAllStructDefender: the defender ids under the protected struct's
   * prefix, in key (byte) order. */
  Chain.prototype.defendersOf = function (protectedId) {
    return Object.keys(this.defenders[protectedId] || {}).sort(function (a, b) { return a < b ? -1 : a > b ? 1 : 0; });
  };

  /* StructType helpers (types/struct_type.go). */
  function weaponField(t, ws, field) { return t[(ws === 'secondaryWeapon' ? 'secondaryWeapon' : 'primaryWeapon') + field]; }
  function canTargetAmbit(t, ws, fromAmbit, toAmbit) {
    var all = weaponField(t, ws, 'Ambits') || 0;
    if (all & AMBIT_FLAG.local) all |= AMBIT_FLAG[fromAmbit];
    return (all & AMBIT_FLAG[toAmbit]) !== 0;
  }
  function canCounterTargetAmbit(t, fromAmbit, toAmbit) {
    var all = (t.primaryWeaponAmbits || 0) | (t.secondaryWeaponAmbits || 0);
    if (all & AMBIT_FLAG.local) all |= AMBIT_FLAG[fromAmbit];
    return (all & AMBIT_FLAG[toAmbit]) !== 0;
  }
  function counterWeaponSystem(t, fromAmbit, toAmbit) {
    return canTargetAmbit(t, 'primaryWeapon', fromAmbit, toAmbit) ? 'primaryWeapon' : 'secondaryWeapon';
  }
  function hasStealthSystem(t) { return t.unitDefenses === 'stealthMode'; }

  /* ── Transactions ──────────────────────────────────────────────────────── */

  /** Queue a message for the next block. Returns the tx hash. */
  Chain.prototype.submit = function (signer, msg) {
    this.txSeq++;
    var hash = (hash32(this.seed + '|' + this.height + '|' + this.txSeq).toString(16).padStart(8, '0')
      + hash32(signer + '|' + this.txSeq + '|' + JSON.stringify(msg)).toString(16).padStart(8, '0')
      + this.txSeq.toString(16).padStart(8, '0')).toUpperCase();
    this.mempool.push({ hash: hash, signer: signer, msg: msg, submittedAt: this.height });
    return hash;
  };

  /** Produce the next block: BeginBlock (sweep), then every queued tx in order. */
  Chain.prototype.produceBlock = function () {
    this.height++;
    var block = { height: this.height, txs: [], events: [] };
    this.sweepDestroyed(block);
    var txs = this.mempool.splice(0);
    for (var i = 0; i < txs.length; i++) block.txs.push(this.deliver(txs[i], block));
    return block;
  };

  /* keeper/struct.go StructSweepDestroyed: structs destroyed
   * STRUCT_SWEEP_DELAY blocks ago leave their slot and the store. */
  Chain.prototype.sweepDestroyed = function (block) {
    var due = this.height - STRUCT_SWEEP_DELAY;
    var ids = (this.destructionQueue[due] || []).slice().sort();
    delete this.destructionQueue[due];
    for (var i = 0; i < ids.length; i++) {
      var s = this.structs[ids[i]];
      if (!s) continue;
      if (this.typeOf(s).type === COMMAND_STRUCT) {
        var f = this.fleets[s.locationId];
        if (f && f.commandStruct === s.id) f.commandStruct = null;
      }
      delete this.structs[ids[i]];
      block.events.push({ category: 'struct_sweep', detail: { struct_id: ids[i] } });
    }
  };

  function clone(x) { return JSON.parse(JSON.stringify(x)); }

  Chain.prototype.deliver = function (tx, block) {
    var saved = clone({ players: this.players, fleets: this.fleets, structs: this.structs, defenders: this.defenders, destructionQueue: this.destructionQueue });
    var ctx = {
      tx: tx, typed: [], before: {}, order: [], counterSpent: {}, blockSeed: hash32(this.seed + '#' + this.height),
    };
    this.ctx = ctx;
    var result = { hash: tx.hash, signer: tx.signer, type: tx.msg['@type'], ok: true, error: null, events: [] };
    try {
      this.route(tx.signer, tx.msg);
      result.events = ctx.typed.concat(this.commitFrames(ctx));
    } catch (e) {
      Object.assign(this, saved);
      result.ok = false;
      result.error = String(e && e.message || e);
      result.code = (e && e.code) || 'error';
    }
    this.ctx = null;
    block.events = block.events.concat(result.events);
    return result;
  };

  Chain.prototype.route = function (signer, msg) {
    switch (msg['@type']) {
      case '/structs.structs.MsgStructAttack': return this.structAttack(signer, msg);
      case '/structs.structs.MsgStructDefenseSet': return this.structDefenseSet(signer, msg);
      case '/structs.structs.MsgStructDefenseClear': return this.structDefenseClear(signer, msg);
      case '/structs.structs.MsgStructMove': return this.structMove(signer, msg);
      case '/structs.structs.MsgStructStealthActivate': return this.structStealth(signer, msg, true);
      case '/structs.structs.MsgStructStealthDeactivate': return this.structStealth(signer, msg, false);
      case '/structs.structs.MsgStructActivate': return this.structActivate(signer, msg);
      case '/structs.structs.MsgStructDeactivate': return this.structDeactivate(signer, msg);
      case '/structs.structs.MsgStructBuildInitiate':
        // FleetCache.BuildInitiateReadiness: an away fleet cannot build.
        throw ChainError('fleet_state', 'fleet ' + (this.players[signer] || {}).fleetId + ' is away: cannot build');
      default:
        throw ChainError('unknown_msg', 'unsupported message ' + msg['@type']);
    }
  };

  /* Attribute writes go through here so the commit can report each struct's
   * net change once, as the indexer does from the attribute store. */
  Chain.prototype.touch = function (s) {
    var ctx = this.ctx;
    if (!ctx || ctx.before[s.id]) return;
    ctx.before[s.id] = { health: s.health, status: s.status, ambit: s.ambit, slot: s.slot };
    ctx.order.push(s.id);
  };
  Chain.prototype.commitFrames = function (ctx) {
    var out = [];
    var self = this;
    ctx.order.forEach(function (id) {
      var s = self.structs[id], was = ctx.before[id];
      if (!s) return;
      var subject = 'structs.planet.' + self.planetId + '.' + s.owner;
      if (was.ambit !== s.ambit || was.slot !== s.slot) {
        out.push({ category: 'struct_move', subject: subject, detail: { struct_id: id, ambit: s.ambit, slot: s.slot, location_type: s.locationType, location_id: s.locationId } });
      }
      if (was.health !== s.health) {
        out.push({ category: 'struct_health', subject: subject, detail: { struct_id: id, health: s.health, health_old: was.health } });
      }
      if (was.status !== s.status) {
        out.push({ category: 'struct_status', subject: subject, detail: { struct_id: id, status: s.status, status_old: was.status } });
      }
    });
    return out;
  };
  Chain.prototype.emit = function (category, detail, subjectOwner) {
    this.ctx.typed.push({ category: category, subject: 'structs.planet.' + this.planetId + (subjectOwner ? '.' + subjectOwner : ''), detail: detail });
  };

  /* Status setters (StructCache.StatusAdd… / StatusRemove…). */
  Chain.prototype.setStatus = function (s, bit, on) {
    this.touch(s);
    s.status = on ? (s.status | bit) : (s.status & ~bit);
  };
  /* CurrentContext.SetStructAttributeDecrement: saturates at zero. */
  Chain.prototype.decrementHealth = function (s, amount) {
    this.touch(s);
    s.health = amount < s.health ? s.health - amount : 0;
    return s.health;
  };
  /* PlayerCache.Discharge: lastAction becomes this block. */
  Chain.prototype.discharge = function (pid) { this.players[pid].lastAction = this.height; };

  Chain.prototype.isSuccessful = function (s, num, den) {
    // fraction.New(n, 0) fails and leaves a zero fraction, so Intn(0) would
    // panic in the chain: the tx fails. No live weapon rolls one.
    if (!den) throw ChainError('fraction', 'invalid success rate ' + num + '/' + den);
    var owner = this.players[s.owner];
    owner.nonce += 1;                           // GetNextNonce increments first
    var draw = Math.floor(mulberry((this.ctx.blockSeed + owner.nonce) >>> 0)() * den) + 1;
    return draw <= num;
  };

  /* ── Struct predicates (keeper/struct_cache.go) ────────────────────────── */

  Chain.prototype.mustLoad = function (id) {
    var s = this.structs[id];
    if (!s) throw ChainError('not_found', 'struct ' + id + ' not found');
    return s;
  };
  Chain.prototype.canBePlayedBy = function (s, signer) {
    if (!s || s.owner !== signer) throw ChainError('permission', 'player ' + signer + ' cannot play struct ' + (s ? s.id : '?'));
  };
  Chain.prototype.readinessCheck = function (s) {
    if (this.isDestroyed(s)) throw ChainError('struct_state', s.id + ' is destroyed (readiness_check)');
    if (!this.isOnline(s)) throw ChainError('struct_state', s.id + ' is offline (readiness_check)');
  };
  Chain.prototype.fleetOf = function (s) { return s.locationType === 'fleet' ? this.fleets[s.locationId] : null; };
  /* isReachable: both fleets are away on the same location list, neighbours
   * there. A defeated fleet has been sent home and reaches nothing here. */
  Chain.prototype.isReachable = function (from, to) {
    var a = this.fleetOf(from), b = this.fleetOf(to);
    return !!(a && b && a.atBattle && b.atBattle);
  };
  /* IsProtecting: defender and target share a location (the same fleet). */
  Chain.prototype.isProtecting = function (defender, target) { return defender.locationId === target.locationId; };
  Chain.prototype.canDefend = function (s) { return !!this.typeOf(s).canDefend; };

  Chain.prototype.canAttack = function (attacker, target, ws) {
    var at = this.typeOf(attacker), tt = this.typeOf(target);
    if (this.isDestroyed(target)) return 'destroyed';
    if (!this.isBuilt(target)) return 'unbuilt';
    if (!canTargetAmbit(at, ws, attacker.ambit, target.ambit)) return 'out_of_range';
    // CanBlockTargeting is always false on chain.
    if (this.isHidden(target) && target.ambit !== attacker.ambit) return 'hidden';
    if (!this.isReachable(attacker, target)) return 'unreachable';
    void tt;
    return null;
  };
  Chain.prototype.canCounterAttack = function (counter, attacker) {
    if (this.isDestroyed(counter) || !this.isOnline(counter)) return 'readiness';
    if (this.ctx.counterSpent[counter.id]) return 'spent';
    if (this.isDestroyed(attacker) || this.isDestroyed(counter)) return 'destroyed';
    if (!canCounterTargetAmbit(this.typeOf(counter), counter.ambit, attacker.ambit)) return 'out_of_range';
    if (!this.isReachable(counter, attacker)) return 'unreachable';
    return null;
  };

  /* DestroyAndCommit — idempotent. */
  Chain.prototype.destroy = function (s) {
    if (this.isDestroyed(s)) return;
    var t = this.typeOf(s);
    this.goOffline(s);
    this.destroyStructDefender(s.id);
    this.setStatus(s, STATUS.DESTROYED, true);
    s.destroyedAt = this.height;
    // CanTriggerRaidDefeatByDestruction: a Command Ship away from home.
    if (t.triggerRaidDefeatByDestruction) {
      var fleet = this.fleetOf(s);
      if (fleet && fleet.atBattle) {
        // FleetCache.Defeat: EventRaid attackerDefeated, fleet sent home.
        this.emit('raid_status', { status: 'attackerDefeated', fleet_id: fleet.id, planet_id: this.planetId }, s.owner);
        fleet.atBattle = false;
      }
    }
    (this.destructionQueue[this.height] = this.destructionQueue[this.height] || []).push(s.id);
  };
  Chain.prototype.goOffline = function (s) {
    if (!this.isOnline(s)) return;
    this.players[s.owner].load -= this.typeOf(s).passiveDraw || 0;
    this.setStatus(s, STATUS.ONLINE, false);
  };
  Chain.prototype.goOnline = function (s) {
    this.players[s.owner].load += this.typeOf(s).passiveDraw || 0;
    this.setStatus(s, STATUS.ONLINE, true);
  };

  /* keeper/struct_defender.go */
  Chain.prototype.setDefender = function (protectedId, defenderId) {
    var d = this.structs[defenderId];
    if (d.protectedStructId && d.protectedStructId !== protectedId) this.removeDefender(d.protectedStructId, defenderId);
    (this.defenders[protectedId] = this.defenders[protectedId] || {})[defenderId] = true;
    d.protectedStructId = protectedId;
    if (this.ctx) this.emit('struct_defense_add', { defender_struct_id: defenderId, protected_struct_id: protectedId }, d.owner);
  };
  Chain.prototype.removeDefender = function (protectedId, defenderId) {
    if (this.defenders[protectedId]) {
      delete this.defenders[protectedId][defenderId];
      if (!Object.keys(this.defenders[protectedId]).length) delete this.defenders[protectedId];
    }
    if (this.ctx) this.emit('struct_defense_remove', { defender_struct_id: defenderId, protected_struct_id: protectedId }, (this.structs[defenderId] || {}).owner);
  };
  Chain.prototype.clearDefender = function (protectedId, defenderId) {
    this.removeDefender(protectedId, defenderId);
    var d = this.structs[defenderId];
    if (d) d.protectedStructId = null;
  };
  /* DestroyStructDefender: clears only the DESTROYED struct's own posture. */
  Chain.prototype.destroyStructDefender = function (defenderId) {
    var d = this.structs[defenderId];
    if (d && d.protectedStructId) this.clearDefender(d.protectedStructId, defenderId);
  };

  /* ── MsgStructAttack (msg_server_struct_attack.go + attack_context.go) ─── */

  Chain.prototype.structAttack = function (signer, msg) {
    var attacker = this.structs[msg.operatingStructId];
    this.canBePlayedBy(attacker, signer);
    this.readinessCheck(attacker);
    var ws = msg.weaponSystem;
    if (WEAPON_SYSTEMS.indexOf(ws) < 0) throw ChainError('parameter', 'weapon_system invalid');
    var at = this.typeOf(attacker);
    if (weaponField(at, ws, '') === 'noActiveWeaponry') throw ChainError('capability', 'struct_type_' + at.id + ' has no ' + ws);
    var cost = weaponField(at, ws, 'Charge') || 0;
    var charge = this.chargeOf(signer);
    if (charge < cost) throw ChainError('insufficient_charge', 'insufficient charge for attack: ' + charge + ' < ' + cost);
    this.setStatus(attacker, STATUS.HIDDEN, false);                 // StatusRemoveHidden
    var targets = msg.targetStructId || [];
    if (targets.length !== (weaponField(at, ws, 'Targets') || 0)) throw ChainError('combat_targeting', 'incomplete_targeting');

    var detail = {
      attackerPlayerId: attacker.owner, attackerStructId: attacker.id, attackerStructTypeId: at.id,
      attackerStructType: at.type, attackerStructLocationType: attacker.locationType,
      attackerStructLocationId: attacker.locationId, attackerStructOperatingAmbit: attacker.ambit,
      attackerStructSlot: attacker.slot, weaponSystem: ws, weaponControl: weaponField(at, ws, 'Control'),
      activeWeaponry: weaponField(at, ws, ''), attackerHealthBefore: attacker.health, attackerHealthMax: at.maxHealth,
      eventAttackShotDetail: [],
    };
    for (var i = 0; i < targets.length; i++) {
      var target = this.structs[targets[i]];
      if (!target) throw ChainError('not_found', 'struct ' + targets[i] + ' not found');
      var shot = this.shotAgainst(attacker, at, ws, target);
      detail.eventAttackShotDetail = detail.eventAttackShotDetail.concat(shot);
      if (this.isDestroyed(attacker)) break;
    }
    // ResolveRecoil
    var recoil = 0, recoilKilled = false;
    if (!this.isDestroyed(attacker)) {
      recoil = weaponField(at, ws, 'RecoilDamage') || 0;
      if (recoil) {
        if (this.decrementHealth(attacker, recoil) === 0) this.destroy(attacker);
        recoilKilled = this.isDestroyed(attacker);
      }
    }
    // ResolvePlanetaryDefense: no planet of either side is targeted here.
    // Finalize
    detail.attackerHealthAfter = attacker.health;
    if (recoil > 0) { detail.recoilDamageToAttacker = true; detail.recoilDamage = recoil; detail.recoilDamageDestroyedAttacker = recoilKilled; }
    this.emit('struct_attack', detail, attacker.owner);
    this.discharge(signer);
  };

  /* One target: BeginShot … EndShot. Returns the shot rows EndShot appends. */
  Chain.prototype.shotAgainst = function (attacker, at, ws, target) {
    var tt = this.typeOf(target);
    var healthBefore = target.health;
    var why = this.canAttack(attacker, target, ws);
    if (why) throw ChainError('combat_targeting', attacker.id + ' cannot attack ' + target.id + ': ' + why);

    // resolveEvasion: one roll per target, on the target's owner nonce.
    var control = weaponField(at, ws, 'Control');
    var num = control === 'guided' ? tt.guidedDefensiveSuccessRateNumerator : tt.unguidedDefensiveSuccessRateNumerator;
    var den = control === 'guided' ? tt.guidedDefensiveSuccessRateDenominator : tt.unguidedDefensiveSuccessRateDenominator;
    var evaded = false;
    // fraction.New(n, 0) is a zero fraction: numerator 0, never evades.
    if (num && den) evaded = this.isSuccessful(target, num, den);

    var r = { evaded: evaded, counters: [], block: null, volley: null, targetCounter: null };
    this.resolveDefenders(attacker, at, ws, target, evaded, r);
    if (!evaded && !(r.block && r.block.blocked) && this.isOnline(attacker)) {
      r.volley = this.volleyOn(attacker, at, ws, target, false);
    }
    // ResolveTargetCounter
    if (at.attackCounterable && weaponField(at, ws, 'Counterable')) {
      if (!this.canCounterAttack(target, attacker)) r.targetCounter = this.counterDamage(attacker, target);
    }
    return this.endShot(attacker, at, ws, target, tt, healthBefore, r);
  };

  Chain.prototype.resolveDefenders = function (attacker, at, ws, target, skipBlock, r) {
    var blockable = !!weaponField(at, ws, 'Blockable');
    var counterable = !!(at.attackCounterable && weaponField(at, ws, 'Counterable'));
    if (!blockable && !counterable) return;
    var wantBlock = blockable && !skipBlock;
    var blocker = null;
    var ids = this.defendersOf(target.id);
    for (var i = 0; i < ids.length; i++) {
      var d = this.structs[ids[i]];
      if (!d) continue;
      if (d.id === target.id || d.id === attacker.id) continue;
      if (this.isDestroyed(d) || !this.isOnline(d)) continue;            // ReadinessCheck
      if (!this.isProtecting(d, target)) continue;
      if (!this.canDefend(d)) continue;
      if (counterable && !this.canCounterAttack(d, attacker)) r.counters.push(this.counterDamage(attacker, d));
      if (wantBlock && !blocker && d.ambit === target.ambit) blocker = d;
      if (this.isDestroyed(attacker)) break;
    }
    if (this.isDestroyed(attacker)) return;
    if (blocker) {
      // resolveBlock re-validates both sides before the volley lands.
      if (this.isDestroyed(blocker) || !this.isOnline(blocker)) return;
      if (this.isDestroyed(attacker) || !this.isOnline(attacker)) return;
      if (blocker.ambit !== target.ambit) return;
      r.block = { blocked: true, blocker: blocker, healthBefore: blocker.health, healthMax: this.typeOf(blocker).maxHealth };
      r.volley = this.volleyOn(attacker, at, ws, blocker, true);
    }
  };

  /* resolveCounterDamage: `counter` hits the attacker. */
  Chain.prototype.counterDamage = function (attacker, counter) {
    var ct = this.typeOf(counter);
    var res = { counter: counter, damage: 0, attackerDestroyed: false, postDestruction: null };
    if (this.isDestroyed(attacker)) return res;
    var damage = attacker.ambit === counter.ambit ? ct.counterAttackSameAmbit : ct.counterAttack;
    res.damage = damage || 0;
    if (damage) {
      this.ctx.counterSpent[counter.id] = true;
      if (this.decrementHealth(attacker, damage) === 0) {
        if (this.typeOf(attacker).postDestructionDamage > 0) res.postDestruction = this.postDestruction(counter, attacker);
        this.destroy(attacker);
      }
    }
    res.attackerDestroyed = this.isDestroyed(attacker);
    res.weaponSystem = counterWeaponSystem(ct, counter.ambit, attacker.ambit);
    res.weaponControl = weaponField(ct, res.weaponSystem, 'Control');
    res.activeWeaponry = weaponField(ct, res.weaponSystem, '');
    res.passiveWeaponry = ct.passiveWeaponry;
    return res;
  };

  /* applyPostDestructionDamageCore: `victim` explodes onto `survivor`. */
  Chain.prototype.postDestruction = function (survivor, victim) {
    if (this.isDestroyed(survivor)) return { damage: 0, attackerDestroyed: false, passive: 'noPassiveWeaponry' };
    var vt = this.typeOf(victim);
    var damage = vt.postDestructionDamage || 0;
    if (damage && this.decrementHealth(survivor, damage) === 0) this.destroy(survivor);
    return { damage: damage, attackerDestroyed: this.isDestroyed(survivor), passive: vt.passiveWeaponry };
  };

  /* resolveVolleyDamageOn */
  Chain.prototype.volleyOn = function (attacker, at, ws, victim, isBlocker) {
    if (this.isDestroyed(attacker)) return { isBlocker: isBlocker, healthAfter: victim.health, shots: [] };
    if (this.isDestroyed(victim)) return { isBlocker: isBlocker, healthAfter: 0, shots: [] };
    var n = weaponField(at, ws, 'Shots') || 0;
    if (!n) return { isBlocker: isBlocker, healthAfter: victim.health, shots: [] };
    var shots = [], rolled = 0;
    var guaranteed = weaponField(at, ws, 'GuaranteedShots') || 0;
    for (var i = 0; i < n; i++) {
      var hit = i < guaranteed || this.isSuccessful(attacker, weaponField(at, ws, 'ShotSuccessRateNumerator'), weaponField(at, ws, 'ShotSuccessRateDenominator'));
      var d = hit ? weaponField(at, ws, 'Damage') : 0;
      shots.push({ hit: hit, damage: d });
      rolled += d;
    }
    var vt = this.typeOf(victim);
    var net = rolled, reduction = vt.attackReduction || 0;
    var piercing = reduction > 0 && !!weaponField(at, ws, 'ArmourPiercing');
    if (piercing) reduction = 0;
    if (rolled !== 0 && reduction > 0) net = reduction >= rolled ? 1 : rolled - reduction;
    var vr = { shots: shots, rolled: rolled, reduction: reduction, unitDefenses: vt.unitDefenses, piercing: piercing, net: net, isBlocker: isBlocker, destroyed: false, postDestruction: null };
    if (net !== 0) {
      if (this.decrementHealth(victim, net) === 0) {
        vr.destroyed = true;
        if (vt.postDestructionDamage > 0) vr.postDestruction = this.postDestruction(attacker, victim);
        this.destroy(victim);
      }
    }
    vr.healthAfter = victim.health;
    return vr;
  };

  /* EndShot: the rows for one target, exactly as the chain builds them. */
  Chain.prototype.endShot = function (attacker, at, ws, target, tt, healthBefore, r) {
    var base = {
      targetStructId: target.id, targetStructTypeId: tt.id, targetStructType: tt.type,
      targetStructLocationType: target.locationType, targetStructLocationId: target.locationId,
      targetStructOperatingAmbit: target.ambit, targetStructSlot: target.slot, targetPlayerId: target.owner,
      targetHealthBefore: healthBefore, targetHealthAfter: target.health, targetDestroyed: this.isDestroyed(target),
      targetHealthMax: tt.maxHealth, eventAttackDefenderCounterDetail: [],
    };
    if (r.evaded) { base.evaded = true; base.evadedCause = tt.unitDefenses; }
    if (r.block && r.block.blocked) {
      var b = r.block.blocker, bt = this.typeOf(b);
      Object.assign(base, {
        blocked: true, blockedByStructId: b.id, blockedByStructTypeId: bt.id, blockedByStructType: bt.type,
        blockedByStructLocationType: b.locationType, blockedByStructLocationId: b.locationId,
        blockedByStructOperatingAmbit: b.ambit, blockedByStructSlot: b.slot,
        blockerHealthBefore: r.block.healthBefore, blockerHealthMax: r.block.healthMax,
      });
    }
    var self = this;
    r.counters.forEach(function (c) {
      var cs = c.counter, ct = self.typeOf(cs);
      base.eventAttackDefenderCounterDetail.push({
        counterByStructId: cs.id, counterDamage: c.damage, counterDestroyedAttacker: c.attackerDestroyed,
        counterByStructTypeId: ct.id, counterByStructType: ct.type, counterByStructLocationType: cs.locationType,
        counterByStructLocationId: cs.locationId, counterByStructOperatingAmbit: cs.ambit, counterByStructSlot: cs.slot,
        counterByStructWeaponSystem: c.weaponSystem, counterByStructWeaponControl: c.weaponControl,
        counterByStructActiveWeaponry: c.activeWeaponry,
      });
    });
    if (r.targetCounter && r.targetCounter.damage > 0) {
      Object.assign(base, {
        targetCountered: true, targetCounteredDamage: r.targetCounter.damage,
        targetCounterDestroyedAttacker: r.targetCounter.attackerDestroyed,
        targetCounterPassiveWeaponry: r.targetCounter.passiveWeaponry,
        targetCounterWeaponSystem: r.targetCounter.weaponSystem,
        targetCounterWeaponControl: r.targetCounter.weaponControl,
        targetCounterActiveWeaponry: r.targetCounter.activeWeaponry,
      });
    }
    var vr = r.volley;
    if (!vr) return [base];
    function aggregate(row) {
      if (vr.rolled !== 0 && vr.reduction > 0) { row.damageReduction = vr.reduction; row.damageReductionCause = vr.unitDefenses; }
      if (vr.piercing) { row.armourPiercing = true; row.damageReductionCause = vr.unitDefenses; }
      row.damage = vr.net || 0;
      if (vr.isBlocker) row.blockerHealthAfter = vr.healthAfter;
      if (vr.isBlocker && vr.destroyed) row.blockerDestroyed = true;
      if (vr.postDestruction) {
        row.postDestructionDamageToAttacker = true;
        row.postDestructionDamage = vr.postDestruction.damage;
        row.postDestructionDamageDestroyedAttacker = vr.postDestruction.attackerDestroyed;
        row.postDestructionDamagePassiveWeaponry = vr.postDestruction.passive;
      }
    }
    var n = vr.shots.length;
    if (n <= 1) {
      if (n === 1) base.damageDealt = vr.shots[0].damage;
      aggregate(base);
      return [base];
    }
    // Multi-shot: n-1 projectile rows with outcomes zeroed, then the last row
    // carrying the volley aggregate (newProjectileRow).
    var rows = [];
    function projectile() {
      var row = clone(base);
      row.eventAttackDefenderCounterDetail = null;
      ['damageDealt', 'damageReduction', 'damage', 'targetCounteredDamage', 'postDestructionDamage', 'targetHealthAfter', 'blockerHealthAfter'].forEach(function (k) { row[k] = 0; });
      ['armourPiercing', 'blockerDestroyed', 'targetDestroyed', 'targetCountered', 'targetCounterDestroyedAttacker', 'postDestructionDamageToAttacker', 'postDestructionDamageDestroyedAttacker'].forEach(function (k) { row[k] = false; });
      ['damageReductionCause', 'targetCounterPassiveWeaponry', 'targetCounterWeaponSystem', 'targetCounterWeaponControl', 'targetCounterActiveWeaponry', 'postDestructionDamagePassiveWeaponry'].forEach(function (k) { delete row[k]; });
      return row;
    }
    for (var i = 0; i < n - 1; i++) {
      var row = projectile();
      row.damageDealt = vr.shots[i].damage;
      row.targetHealthAfter = base.targetHealthBefore;
      if (vr.isBlocker) row.blockerHealthAfter = base.blockerHealthBefore;
      rows.push(row);
    }
    var last = projectile();
    last.damageDealt = vr.shots[n - 1].damage;
    aggregate(last);
    last.targetHealthAfter = base.targetHealthAfter;
    last.targetDestroyed = base.targetDestroyed;
    last.eventAttackDefenderCounterDetail = base.eventAttackDefenderCounterDetail;
    ['targetCountered', 'targetCounteredDamage', 'targetCounterDestroyedAttacker', 'targetCounterPassiveWeaponry',
      'targetCounterWeaponSystem', 'targetCounterWeaponControl', 'targetCounterActiveWeaponry'].forEach(function (k) {
      if (base[k] !== undefined) last[k] = base[k];
    });
    rows.push(last);
    return rows;
  };

  /* ── MsgStructDefenseSet / MsgStructDefenseClear ───────────────────────── */

  Chain.prototype.structDefenseSet = function (signer, msg) {
    var s = this.structs[msg.defenderStructId];
    this.canBePlayedBy(s, signer);
    s = this.mustLoad(msg.defenderStructId);
    if (this.isDestroyed(s)) throw ChainError('struct_state', s.id + ' is destroyed (defense_set)');
    if (!this.isOnline(s)) throw ChainError('struct_state', s.id + ' is offline (defense_set)');
    if (!this.canDefend(s)) throw ChainError('cannot_defend', s.id + ' cannot defend');
    var cost = this.typeOf(s).defendChangeCharge || 0;
    var charge = this.chargeOf(signer);
    if (charge < cost) throw ChainError('insufficient_charge', 'insufficient charge for defend: ' + charge + ' < ' + cost);
    if (msg.defenderStructId === msg.protectedStructId) throw ChainError('struct_location', 'self_defense');
    var ward = this.mustLoad(msg.protectedStructId);
    if (!this.isProtecting(s, ward)) throw ChainError('struct_location', 'not_in_range');
    this.setDefender(ward.id, s.id);
    this.discharge(signer);
  };

  Chain.prototype.structDefenseClear = function (signer, msg) {
    var s = this.structs[msg.defenderStructId];
    this.canBePlayedBy(s, signer);
    s = this.mustLoad(msg.defenderStructId);
    if (this.isDestroyed(s)) throw ChainError('struct_state', s.id + ' is destroyed (defense_clear)');
    if (!this.isOnline(s)) throw ChainError('struct_state', s.id + ' is offline (defense_clear)');
    var cost = this.typeOf(s).defendChangeCharge || 0;
    var charge = this.chargeOf(signer);
    if (charge < cost) throw ChainError('insufficient_charge', 'insufficient charge for defend: ' + charge + ' < ' + cost);
    if (!s.protectedStructId) throw ChainError('struct_state', s.id + ' is not defending (defense_clear)');
    this.clearDefender(s.protectedStructId, s.id);
    this.discharge(signer);
  };

  /* ── MsgStructMove (AttemptMove + FleetCache.MoveReadiness) ────────────── */

  Chain.prototype.structMove = function (signer, msg) {
    var s = this.structs[msg.structId];
    this.canBePlayedBy(s, signer);
    s = this.mustLoad(msg.structId);
    if (this.isDestroyed(s)) throw ChainError('struct_state', s.id + ' is destroyed (move)');
    var t = this.typeOf(s);
    var cost = t.moveCharge || 0;
    var charge = this.chargeOf(signer);
    if (charge < cost) throw ChainError('insufficient_charge', 'insufficient charge for move: ' + charge + ' < ' + cost);
    if (!this.isOnline(s)) throw ChainError('struct_state', s.id + ' is offline (move)');
    if (!t.movable) throw ChainError('struct_location', 'immovable');
    var ambit = String(msg.ambit || '').toLowerCase();
    if (msg.locationType !== 'fleet') throw ChainError('struct_location', 'fleet ' + this.players[signer].fleetId + ' is away: no planet to move to');
    if (t.category !== 'fleet') throw ChainError('struct_location', 'outside_planet');
    if (!AMBIT_FLAG[ambit] || ambit === 'local' || (AMBIT_FLAG[ambit] & t.possibleAmbit) === 0) throw ChainError('struct_location', 'invalid_ambit');
    if (t.type !== COMMAND_STRUCT) {
      var slot = Number(msg.slot);
      if (!(slot >= 0 && slot < 4)) throw ChainError('struct_build', 'slot_unavailable');
      var taken = Object.keys(this.structs).some(function (id) {
        var o = this.structs[id];
        return o.id !== s.id && o.locationId === s.locationId && o.ambit === ambit && o.slot === slot && this.typeOf(o).type !== COMMAND_STRUCT;
      }, this);
      if (taken) throw ChainError('struct_build', 'slot_occupied');
      this.touch(s);
      s.ambit = ambit; s.slot = slot;
    } else {
      // A Command Ship changes only its operating ambit.
      this.touch(s);
      s.ambit = ambit;
    }
    this.discharge(signer);
  };

  /* ── Stealth, activation ───────────────────────────────────────────────── */

  Chain.prototype.structStealth = function (signer, msg, activate) {
    var s = this.structs[msg.structId];
    this.canBePlayedBy(s, signer);
    this.readinessCheck(s);
    if (activate && this.isHidden(s)) throw ChainError('struct_state', s.id + ' is hidden (stealth_activate)');
    if (!activate && !this.isHidden(s)) throw ChainError('struct_state', s.id + ' is visible (stealth_deactivate)');
    var t = this.typeOf(s);
    if (!hasStealthSystem(t)) throw ChainError('capability', s.id + ' has no stealth');
    var cost = t.stealthActivateCharge || 0;
    var charge = this.chargeOf(signer);
    if (charge < cost) throw ChainError('insufficient_charge', 'insufficient charge for stealth: ' + charge + ' < ' + cost);
    this.discharge(signer);
    this.setStatus(s, STATUS.HIDDEN, activate);
  };

  Chain.prototype.structActivate = function (signer, msg) {
    var s = this.structs[msg.structId];
    this.canBePlayedBy(s, signer);
    if (!s) throw ChainError('not_found', 'struct not found');
    if (this.isDestroyed(s)) throw ChainError('struct_state', s.id + ' is destroyed (activation)');
    if (!this.isBuilt(s)) throw ChainError('struct_state', s.id + ' is building (activation)');
    if (this.isOnline(s)) throw ChainError('struct_state', s.id + ' is online (activation)');
    var p = this.players[signer], t = this.typeOf(s);
    if (p.load + (t.passiveDraw || 0) > p.capacity) throw ChainError('player_power', 'capacity_exceeded');
    var cost = t.activateCharge || 0;
    var charge = this.chargeOf(signer);
    if (charge < cost) throw ChainError('insufficient_charge', 'insufficient charge for activate: ' + charge + ' < ' + cost);
    this.discharge(signer);
    this.goOnline(s);
  };

  Chain.prototype.structDeactivate = function (signer, msg) {
    var s = this.structs[msg.structId];
    if (!s) throw ChainError('not_found', 'struct not found');
    this.canBePlayedBy(s, signer);
    if (!this.isBuilt(s)) throw ChainError('struct_state', s.id + ' is building (deactivate)');
    if (!this.isOnline(s)) throw ChainError('struct_state', s.id + ' is offline (deactivate)');
    // MsgStructDeactivate neither checks nor spends charge.
    this.goOffline(s);
  };

  /** An independent copy of the whole state with a different randomness
   * seed: the computer player plays candidate moves forward on one of these
   * through the same rules, never on the battle itself. */
  Chain.prototype.fork = function (salt) {
    var f = Object.create(Chain.prototype);
    f.types = this.types;
    f.seed = this.seed + '/' + salt;
    f.height = this.height;
    f.planetId = this.planetId;
    var copy = clone({ players: this.players, fleets: this.fleets, structs: this.structs, defenders: this.defenders, destructionQueue: this.destructionQueue });
    f.players = copy.players; f.fleets = copy.fleets; f.structs = copy.structs;
    f.defenders = copy.defenders; f.destructionQueue = copy.destructionQueue;
    f.mempool = clone(this.mempool);
    f.txSeq = this.txSeq;
    return f;
  };

  /* ── Outcome ───────────────────────────────────────────────────────────── */

  /** Fleets still at the battle. One left (or none) ends it. */
  Chain.prototype.fleetsAtBattle = function () {
    return Object.keys(this.fleets).filter(function (id) { return this.fleets[id].atBattle; }, this);
  };

  Chain.canTargetAmbit = canTargetAmbit;
  Chain.canCounterTargetAmbit = canCounterTargetAmbit;
  Chain.hasStealthSystem = hasStealthSystem;
  Chain.weaponField = weaponField;
  root.SimulatorChain = Chain;
})(typeof window !== 'undefined' ? window : globalThis);
