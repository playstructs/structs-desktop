/* The computer player. It plays by the same rules as a person: one signer,
 * the chain's charge, one message per block that it can afford, sent after a
 * reaction delay. It reads chain state the way a bot reads the stream (stealth
 * status is public), and it judges an attack by playing it forward on forks
 * of the chain — the real resolution, not an estimate of it.
 */
(function (root) {
  'use strict';
  var Chain = root.SimulatorChain;
  var COMMAND = 'Command Ship';

  var LEVELS = {
    // samples: forks per candidate attack; wait: how much charge it will hold
    // for a better shot; guard/move/stealth: which tools it uses at all;
    // spread: picks among its top N moves instead of always the best.
    //
    // Tuned 2026-10-06 against human stand-ins that act once every ~8 s
    // (a person reading the board and clicking weapon then target), one with
    // Difficult-quality choices and one that picks loosely. Win rate for the
    // person, loose / sharp (60 battles each): Easy 72% / 80%, Difficult 42% / 65%,
    // Hard 5% / 22% with most of the rest drawn. Reaction slowed again the same
    // day ("the computer is too fast"): a decision every ~20 / 14 / 8 s.
    // Before, Difficult decided almost every block and always took its best
    // look-ahead result — 15% / 50%, and a person was 3 hulls down in a
    // minute. Charge, not reaction time, sets how often anyone can fire, so
    // the lever that made it humane was choosing like a person (spread, no
    // holding charge for the perfect shot), not merely slowing it down.
    easy: { reactionMs: 20000, samples: 1, wait: false, guard: false, move: false, stealth: false, noise: 2.5 },
    difficult: { reactionMs: 14000, samples: 3, wait: false, guard: true, move: false, stealth: false, noise: 0.6, spread: 3 },
    hard: { reactionMs: 8000, samples: 6, wait: true, guard: true, move: true, stealth: true, noise: 0 },
  };

  function Ai(playerId, difficulty, seed) {
    this.pid = playerId;
    this.level = LEVELS[difficulty] || LEVELS.difficult;
    this.difficulty = difficulty;
    var n = 0, s = String(seed || '') + playerId;
    for (var i = 0; i < s.length; i++) n = (Math.imul(n ^ s.charCodeAt(i), 16777619) >>> 0);
    this.state = n || 1;
  }
  Ai.LEVELS = LEVELS;
  Ai.prototype.rand = function () {
    this.state = (Math.imul(this.state ^ (this.state >>> 15), 1 | this.state) + 0x6D2B79F5) >>> 0;
    return (this.state >>> 8) / 16777216;
  };

  function alive(chain, s) { return !chain.isDestroyed(s); }
  function mine(chain, pid) { return Object.keys(chain.structs).map(function (id) { return chain.structs[id]; }).filter(function (s) { return s.owner === pid && alive(chain, s); }); }
  function theirs(chain, pid) { return Object.keys(chain.structs).map(function (id) { return chain.structs[id]; }).filter(function (s) { return s.owner !== pid && alive(chain, s); }); }
  function isCommand(chain, s) { return chain.typeOf(s).type === COMMAND; }

  /* Value of a board for `pid`: hulls weighted by health, the Command Ships
   * dominating because they end the battle. */
  function score(chain, pid) {
    var v = 0;
    Object.keys(chain.structs).forEach(function (id) {
      var s = chain.structs[id], t = chain.typeOf(s);
      var hp = chain.isDestroyed(s) ? 0 : s.health;
      var w = (isCommand(chain, s) ? 6 : 1) * hp / t.maxHealth + (hp > 0 ? (isCommand(chain, s) ? 40 : 1) : 0);
      v += s.owner === pid ? w : -w;
    });
    var fleets = chain.fleetsAtBattle();
    var own = chain.players[pid].fleetId;
    if (fleets.indexOf(own) < 0) v -= 1000;
    else if (fleets.length === 1) v += 1000;
    return v;
  }

  /* Expected value of `msg` sent now, by playing the next block forward. */
  Ai.prototype.evaluate = function (chain, msg) {
    var total = 0, n = this.level.samples;
    for (var i = 0; i < n; i++) {
      var f = chain.fork('ai' + chain.height + ':' + i + ':' + JSON.stringify(msg).length + ':' + this.rand());
      f.mempool = [];
      f.submit(this.pid, msg);
      var b = f.produceBlock();
      if (!b.txs[0].ok) return null;
      total += score(f, this.pid);
    }
    return total / n - score(chain, this.pid);
  };

  function attackMsgs(chain, pid) {
    var out = [];
    mine(chain, pid).forEach(function (a) {
      if (!chain.isOnline(a)) return;
      var t = chain.typeOf(a);
      ['primaryWeapon', 'secondaryWeapon'].forEach(function (ws) {
        if (Chain.weaponField(t, ws, '') === 'noActiveWeaponry') return;
        if ((Chain.weaponField(t, ws, 'Targets') || 0) !== 1) return;
        theirs(chain, pid).forEach(function (target) {
          if (chain.canAttack(a, target, ws)) return;
          out.push({ cost: Chain.weaponField(t, ws, 'Charge') || 0, msg: { '@type': '/structs.structs.MsgStructAttack', operatingStructId: a.id, targetStructId: [target.id], weaponSystem: ws } });
        });
      });
    });
    return out;
  }

  /* Who could shoot `s` where it stands (or at `ambit`). */
  function threatsTo(chain, pid, s, ambit) {
    var ghost = Object.assign({}, s, { ambit: ambit || s.ambit });
    return theirs(chain, pid).filter(function (e) {
      return chain.isOnline(e) && ['primaryWeapon', 'secondaryWeapon'].some(function (ws) {
        return Chain.weaponField(chain.typeOf(e), ws, '') !== 'noActiveWeaponry' && !chain.canAttack(e, ghost, ws);
      });
    }).length;
  }

  /** Decide this block's message, or null to keep charging. */
  Ai.prototype.decide = function (chain) {
    var pid = this.pid, L = this.level, self = this;
    var player = chain.players[pid];
    if (!player || chain.fleetsAtBattle().indexOf(player.fleetId) < 0) return null;
    var next = chain.height + 1;
    var charge = chain.chargeOf(pid, next);
    var options = [];
    var attacks = attackMsgs(chain, pid);
    var best = { value: -Infinity };

    attacks.forEach(function (o) {
      if (o.cost > charge && !L.wait) return;
      var v = self.evaluate(chain, o.msg);
      if (v == null) return;
      v += L.noise * (self.rand() - 0.5) * 4;
      var opt = { msg: o.msg, cost: o.cost, value: v };
      if (o.cost <= charge) options.push(opt);
      if (v > best.value) best = opt;
    });

    var command = mine(chain, pid).filter(function (s) { return isCommand(chain, s); })[0];
    if (command && L.guard) {
      // Guard the Command Ship with a same-ambit hull that is not already on it.
      mine(chain, pid).forEach(function (d) {
        if (d === command || !chain.isOnline(d) || !chain.canDefend(d) || d.protectedStructId === command.id) return;
        if (d.ambit !== command.ambit && command.health > 3) return;
        var cost = chain.typeOf(d).defendChangeCharge || 0;
        if (cost > charge) return;
        var urgency = (threatsTo(chain, pid, command) > 0 ? 3 : 0.5) + (d.ambit === command.ambit ? 2 : 0) + (command.health <= 3 ? 3 : 0);
        options.push({ value: urgency, cost: cost, msg: { '@type': '/structs.structs.MsgStructDefenseSet', defenderStructId: d.id, protectedStructId: command.id } });
      });
    }
    if (command && L.move && chain.isOnline(command)) {
      var here = threatsTo(chain, pid, command);
      var cost = chain.typeOf(command).moveCharge || 0;
      Chain.AMBITS.forEach(function (ambit) {
        if (ambit === command.ambit || cost > charge) return;
        if ((Chain.AMBIT_FLAG[ambit] & chain.typeOf(command).possibleAmbit) === 0) return;
        var there = threatsTo(chain, pid, command, ambit);
        if (there < here) options.push({ value: (here - there) * (command.health <= 3 ? 4 : 1.2), cost: cost, msg: { '@type': '/structs.structs.MsgStructMove', structId: command.id, locationType: 'fleet', ambit: ambit, slot: 0 } });
      });
    }
    if (L.stealth) {
      mine(chain, pid).forEach(function (s) {
        var t = chain.typeOf(s);
        if (!Chain.hasStealthSystem(t) || chain.isHidden(s) || !chain.isOnline(s)) return;
        // Stealth spends the whole charge (Discharge), so only when it can
        // just afford it, there is little else to lose, and the hull is exposed.
        var cost = t.stealthActivateCharge || 0;
        if (cost > charge || charge > cost + 1 || threatsTo(chain, pid, s) === 0) return;
        options.push({ value: 1.5, cost: cost, msg: { '@type': '/structs.structs.MsgStructStealthActivate', structId: s.id } });
      });
    }

    options.sort(function (a, b) { return b.value - a.value; });
    var pick = options[0] || null;
    // spread: choose among the top few rather than always the best — a
    // sound move a person would also find, not the optimum every time.
    if (L.spread > 1 && options.length) {
      var top = options.slice(0, L.spread).filter(function (o) { return o.value > -1; });
      if (top.length) pick = top[Math.floor(this.rand() * top.length)];
    }
    // Easy plays loosely, not suicidally: any move at random, except sending
    // the Command Ship into an exchange its look-ahead expects to lose. Drawing
    // from every option walked it into guarded targets until the counters
    // killed it — 38 of 40 benchmark battles over in ~27 blocks. Filtering out
    // every losing move instead made Easy as strong as Difficult.
    if (this.difficulty === 'easy' && options.length) {
      var loose = options.filter(function (o) { return !(command && o.msg.operatingStructId === command.id && o.value < 0); });
      pick = loose.length ? loose[Math.floor(this.rand() * loose.length)] : null;
    }
    // Holding charge: a clearly better attack is within reach of more charge.
    if (L.wait && best.cost > charge && (!pick || best.value > pick.value * 1.5 + 1)) return null;
    if (!pick) return null;
    // An attack expected to cost more than it takes is not worth the charge.
    if (this.difficulty !== 'easy' && pick.value <= -1) return null;
    return pick.msg;
  };

  root.SimulatorAi = Ai;
})(typeof window !== 'undefined' ? window : globalThis);
