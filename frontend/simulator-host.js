/* The simulator's stand-in for the app's Rust side, as the embedded Map
 * Viewer sees it.
 *
 * raidview.html runs unmodified in an iframe; with no Tauri runtime there,
 * bridge.js asks its parent to invoke and listen by message. This answers
 * those asks from the local chain with the same shapes src-tauri/src/mcp
 * produces for a live raid — spectator::Snapshot, collect_shots,
 * raid_view::log_row, players::struct_act — and pushes the same events
 * (raid-block, raid-delta, raid-attacks, raid-log, raid-tx, raid-snapshot).
 */
(function (root) {
  'use strict';

  var BLOCK_MS = 6000;   // structs-webapp TaskConstants.ESTIMATED_BLOCK_TIME

  /* spectator::type_slug — the asset slug for a type name. */
  function typeSlug(name) {
    return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  }

  /* spectator::parse_struct_type + merge_synced_copy, from a chain record
   * that already carries the production copy (simulator-types.js). */
  function spectatorType(t) {
    return {
      class_abbreviation: t.classAbbreviation || t.type, class_name: t['class'] || t.type,
      default_cosmetic_model_number: t.defaultCosmeticModelNumber || '', category: t.category,
      primary_weapon: t.primaryWeapon, primary_weapon_control: t.primaryWeaponControl,
      secondary_weapon: t.secondaryWeapon, secondary_weapon_control: t.secondaryWeaponControl,
      passive_weaponry: t.passiveWeaponry, unit_defenses: t.unitDefenses,
      ore_reserve_defenses: t.oreReserveDefenses, planetary_defenses: t.planetaryDefenses,
      planetary_mining: t.planetaryMining, planetary_refinery: t.planetaryRefinery,
      power_generation: t.powerGeneration, stealth_systems: !!t.stealthSystems, movable: !!t.movable,
      build_charge: t.buildCharge || 0, build_draw: Math.floor((t.buildDraw || 0) / 1000),
      generating_rate: t.generatingRate || 0, planetary_shield_contribution: t.planetaryShieldContribution || 0,
      counter_attack: t.counterAttack || 0, counter_attack_same_ambit: t.counterAttackSameAmbit || 0,
      possible_ambit: t.possibleAmbit || 0, primary_weapon_ambits: t.primaryWeaponAmbits || 0,
      secondary_weapon_ambits: t.secondaryWeaponAmbits || 0,
      primary_weapon_damage: t.primaryWeaponDamage || 0, primary_weapon_shots: t.primaryWeaponShots || 0,
      primary_weapon_charge: t.primaryWeaponCharge || 0, primary_weapon_armour_piercing: !!t.primaryWeaponArmourPiercing,
      secondary_weapon_damage: t.secondaryWeaponDamage || 0, secondary_weapon_shots: t.secondaryWeaponShots || 0,
      secondary_weapon_charge: t.secondaryWeaponCharge || 0, secondary_weapon_armour_piercing: !!t.secondaryWeaponArmourPiercing,
      move_charge: t.moveCharge || 0, defend_change_charge: t.defendChangeCharge || 0,
      stealth_activate_charge: t.stealthActivateCharge || 0,
      primary_weapon_label: t.primary_weapon_label || '', primary_weapon_description: t.primary_weapon_description || '',
      secondary_weapon_label: t.secondary_weapon_label || '', secondary_weapon_description: '',
      passive_weaponry_label: t.passive_weaponry_label || '', passive_weaponry_description: t.passive_weaponry_description || '',
      unit_defenses_label: t.unit_defenses_label || '', unit_defenses_description: t.unit_defenses_description || '',
      ore_reserve_defenses_label: '', ore_reserve_defenses_description: '',
      planetary_defenses_label: '', planetary_defenses_description: '',
      drive_label: t.drive_label || '', drive_description: t.drive_description || '',
    };
  }

  /* ── raid_view.rs log rows, ported ─────────────────────────────────────── */

  var STATUS_NAMES = [[1, 'materialized'], [2, 'built'], [4, 'online'], [8, 'stored'], [16, 'hidden'], [32, 'destroyed'], [64, 'locked']];
  function statusFlags(mask) {
    var set = STATUS_NAMES.filter(function (f) { return mask & f[0]; }).map(function (f) { return f[1]; });
    return set.length ? set.join(', ') : 'none';
  }
  function activityKind(category) {
    switch (category) {
      case 'struct_attack': case 'raid_status': return 'combat';
      case 'shield_change': case 'block_raid_start': case 'struct_defense_add': case 'struct_defense_remove': return 'defense';
      case 'fleet_arrive': case 'fleet_depart': case 'struct_move': return 'movement';
      default: return 'state';
    }
  }
  function describeAttack(d) {
    var weapon = d.weaponControl === 'guided' ? 'smart' : d.weaponControl === 'unguided' ? 'ballistic' : '';
    var attacker = d.attackerStructType ? d.attackerStructType + ' ' + d.attackerStructId : d.attackerStructId;
    var shots = d.eventAttackShotDetail || [];
    var dealt = 0, evaded = 0, blocked = 0, countered = 0, destroyed = [], targets = [];
    shots.forEach(function (shot) {
      dealt += Math.max(0, (Number(shot.damageDealt) || 0) - (Number(shot.damageReduction) || 0));
      if (shot.evaded === true) evaded++;
      if (shot.blocked === true) blocked++;
      countered += Number(shot.targetCounteredDamage) || 0;
      (shot.eventAttackDefenderCounterDetail || []).forEach(function (c) { countered += Number(c.counterDamage) || 0; });
      var label = shot.targetStructType ? shot.targetStructType + ' ' + shot.targetStructId : shot.targetStructId;
      if (shot.targetDestroyed === true && label) destroyed.push(label);
      if (label && targets.indexOf(label) < 0) targets.push(label);
    });
    var target = targets.length === 1 ? targets[0] : targets.length + ' targets';
    var out = attacker + ' → ' + target + (weapon ? ' (' + weapon + ')' : '') + ', ' + dealt + ' dmg';
    if (shots.length > 1) out += ' over ' + shots.length + ' shots';
    if (blocked) out += ', ' + blocked + ' blocked';
    if (evaded) out += ', ' + evaded + ' evaded';
    if (countered) out += ', countered for ' + countered;
    if (destroyed.length) out += ' — DESTROYED ' + destroyed.join(', ');
    return out;
  }
  function describeActivity(category, d) {
    switch (category) {
      case 'struct_attack': return describeAttack(d);
      case 'raid_status': return 'raid ' + d.status + (d.fleet_id ? ' by fleet ' + d.fleet_id : '');
      case 'struct_health':
        if (d.health_old != null && d.health_old !== d.health) return d.struct_id + ' health ' + d.health_old + ' → ' + d.health;
        return d.struct_id + ' health ' + d.health;
      case 'struct_status':
        return d.struct_id + ' ' + (d.status_old != null ? statusFlags(d.status_old) + ' → ' : '') + statusFlags(d.status);
      case 'struct_defense_add': return d.defender_struct_id + ' now defends ' + d.protected_struct_id;
      case 'struct_defense_remove': return d.defender_struct_id + ' stopped defending ' + d.protected_struct_id;
      case 'struct_move': return d.struct_id + ' moved to ' + d.ambit + ' slot ' + d.slot + ' on ' + d.location_id;
      default: return JSON.stringify(d);
    }
  }
  function pad(n) { return String(n).padStart(2, '0'); }

  /* ── Host ──────────────────────────────────────────────────────────────── */

  function Host(opts) {
    this.chain = opts.chain;
    this.you = opts.you;                 // { id, name, pfp }
    this.cpu = opts.cpu;
    this.ai = opts.ai;
    this.label = opts.label || 'sim';
    this.blockMs = opts.blockMs || BLOCK_MS;
    this.frame = opts.frame;             // () => the iframe's window
    this.onChange = opts.onChange || function () {};
    this.generation = 1;
    this.logRows = [];
    this.running = false;
    this.finished = null;
    this.blockTimer = null;
    this.aiTimer = null;
    this.elapsed = 0;
    this.lastTick = null;
    this.structTypes = {};
    var self = this;
    Object.keys(this.chain.types).forEach(function (id) { self.structTypes[id] = spectatorType(self.chain.types[id]); });
    this.onMessage = this.onMessage.bind(this);
    root.addEventListener('message', this.onMessage);
  }
  Host.BLOCK_MS = BLOCK_MS;
  Host.typeSlug = typeSlug;
  Host.describeActivity = describeActivity;

  Host.prototype.destroy = function () {
    this.stop();
    root.removeEventListener('message', this.onMessage);
  };

  Host.prototype.post = function (msg) {
    var w = this.frame && this.frame();
    if (!w) return;
    var origin = String(root.location && root.location.origin || '');
    try { w.postMessage(msg, origin && origin !== 'null' ? origin : '*'); } catch (e) { /* frame gone */ }
  };
  Host.prototype.emit = function (name, payload) {
    this.post({ structs: 'bridge', kind: 'event', name: name + '::' + this.label, payload: payload });
  };

  Host.prototype.onMessage = function (ev) {
    var m = ev.data;
    if (!m || m.structs !== 'bridge') return;
    var w = this.frame && this.frame();
    if (!w || ev.source !== w) return;
    if (m.kind === 'invoke') {
      var self = this;
      Promise.resolve().then(function () { return self.invoke(m.cmd, m.args || {}); }).then(function (value) {
        self.post({ structs: 'bridge', kind: 'result', id: m.id, ok: true, value: value === undefined ? null : value });
      }, function (e) {
        self.post({ structs: 'bridge', kind: 'result', id: m.id, ok: false, error: String(e && e.message || e) });
      });
    }
    // `listen` needs no bookkeeping: every event is posted to the one frame,
    // and bridge.js hands each only to the names it subscribed.
  };

  /** The commands the Map Viewer calls, answered locally. */
  Host.prototype.invoke = function (cmd, args) {
    switch (cmd) {
      case 'events_listening': return null;
      case 'mcp_raid_state': return { generation: this.generation, snapshot: this.snapshot(), catalog: [] };
      case 'mcp_roster': {
        var p = this.chain.players[this.you.id];
        return { rows: [{ player_id: this.you.id, charge: this.displayCharge(this.you.id), load: p.load, structs_load: 0, capacity: p.capacity, connection_capacity: 0 }] };
      }
      case 'mcp_raid_log': return { rows: this.logRows.slice().reverse().slice(0, args.limit || 200), players: this.players() };
      case 'mcp_struct_act': return this.act(args.player, args.action, args.args || {});
      case 'sound_config_get': case 'sound_bytes': case 'sound_trace': {
        // The player's own sound design, read-only — the same three the
        // Terminal forwards for an embedded Map Viewer (FRAME_CMDS).
        var T = root.__TAURI__;
        if (!T || !T.core) throw new Error('no sound runtime');
        return T.core.invoke(cmd, args);
      }
      default:
        throw new Error(cmd + ' is not part of the simulator');
    }
  };

  /* players::build_virtual_msg — the map's action vocabulary → chain messages. */
  Host.prototype.act = function (player, action, a) {
    if (player !== this.you.id) throw new Error('Error: no key for ' + player);
    if (!this.running) throw new Error('Error: the battle is ' + (this.finished ? 'over' : 'paused'));
    var msg;
    switch (action) {
      case 'attack': msg = { '@type': '/structs.structs.MsgStructAttack', operatingStructId: a.attacker_id, targetStructId: [a.target_id], weaponSystem: a.weapon === 'secondary' || a.weapon === 'secondaryWeapon' ? 'secondaryWeapon' : 'primaryWeapon' }; break;
      case 'defend': msg = { '@type': '/structs.structs.MsgStructDefenseSet', defenderStructId: a.defender_id, protectedStructId: a.protected_id }; break;
      case 'defense_clear': msg = { '@type': '/structs.structs.MsgStructDefenseClear', defenderStructId: a.defender_id }; break;
      case 'deploy': msg = { '@type': '/structs.structs.MsgStructMove', structId: a.struct_id, locationType: a.location_type || 'fleet', ambit: a.ambit, slot: Number(a.slot) || 0 }; break;
      case 'stealth_activate': msg = { '@type': '/structs.structs.MsgStructStealthActivate', structId: a.struct_id }; break;
      case 'stealth_deactivate': msg = { '@type': '/structs.structs.MsgStructStealthDeactivate', structId: a.struct_id }; break;
      case 'activate': msg = { '@type': '/structs.structs.MsgStructActivate', structId: a.struct_id }; break;
      case 'deactivate': msg = { '@type': '/structs.structs.MsgStructDeactivate', structId: a.struct_id }; break;
      case 'build': msg = { '@type': '/structs.structs.MsgStructBuildInitiate', structTypeId: a.struct_type_id, operatingAmbit: a.ambit, slot: a.slot }; break;
      default: throw new Error("'" + action + "' is not a struct action the map offers");
    }
    var hash = this.chain.submit(player, msg);
    return '[' + this.you.name + '] ' + action + ' submitted — tx ' + hash;
  };

  /* ChargeCalculator.calcCharge, the figure the HUD shows. */
  Host.prototype.displayCharge = function (pid) {
    var p = this.chain.players[pid];
    return p ? Math.max(0, this.chain.height - (p.lastAction + 1)) : 0;
  };

  Host.prototype.players = function () {
    var out = {};
    out[this.you.id] = { name: this.you.name, pfp: this.you.pfp, tag: null };
    out[this.cpu.id] = { name: this.cpu.name, pfp: this.cpu.pfp, tag: null };
    return out;
  };

  /* spectator::Snapshot for the battle. The player is drawn on the left (the
   * map's `defender` columns), the computer on the right. Neither fleet is at
   * home, so the planet has no slots of its own here. */
  Host.prototype.snapshot = function () {
    var chain = this.chain, self = this;
    var protects = {};
    Object.keys(chain.structs).forEach(function (id) {
      var s = chain.structs[id];
      if (s.protectedStructId) protects[s.protectedStructId] = true;
    });
    var structs = Object.keys(chain.structs).map(function (id) {
      var s = chain.structs[id], t = chain.typeOf(s);
      var fleet = chain.fleets[s.locationId];
      return {
        id: s.id, type_id: t.id, type_name: t.type, type_slug: typeSlug(t.type), category: 'fleet',
        owner: s.owner, ambit: s.ambit, slot: s.slot, health: s.health, max_health: t.maxHealth,
        destroyed: chain.isDestroyed(s), online: chain.isOnline(s), built: chain.isBuilt(s), hidden: chain.isHidden(s),
        defending: !!s.protectedStructId, defended: !!protects[s.id], protects: s.protectedStructId || null,
        is_command: !!(fleet && fleet.commandStruct === s.id),
        side: s.owner === self.you.id ? 'defender' : 'attacker',
      };
    }).filter(function (s) {
      // A defeated fleet has been sent home (FleetCache.Defeat) and is no
      // longer on this location's map.
      var fleet = chain.fleets[chain.structs[s.id].locationId];
      return fleet && fleet.atBattle || s.destroyed;
    });
    var typeIds = {};
    structs.forEach(function (s) { typeIds[s.type_id] = true; });
    var types = {};
    Object.keys(typeIds).forEach(function (id) { types[id] = self.structTypes[id]; });
    var you = chain.players[this.you.id], cpu = chain.players[this.cpu.id];
    var cpuFleet = chain.fleets[cpu.fleetId];
    return {
      planet_id: chain.planetId, owner: this.you.id, planetary_shield: 0, block_start_raid: 0,
      raid_status: null, raiding_fleet: cpuFleet && cpuFleet.atBattle ? cpuFleet.id : null,
      fleets: Object.keys(chain.fleets), slots: { space: 0, air: 0, land: 0, water: 0 },
      structs: structs, struct_types: types, stored_ore: null,
      owner_charge: this.displayCharge(this.you.id), viewer_charge: this.displayCharge(this.you.id), owner_energy: null,
      owner_name: this.you.name, owner_pfp: this.you.pfp,
      raider_id: this.cpu.id, raider_name: this.cpu.name, raider_charge: this.displayCharge(this.cpu.id), raider_pfp: this.cpu.pfp,
      owner_overloaded: you.load > you.capacity, raider_overloaded: cpu.load > cpu.capacity,
      height: chain.height, owner_last_action: you.lastAction, raider_last_action: cpu.lastAction,
      viewer_last_action: you.lastAction, fetched_at_ms: Date.now(), warning: null,
      owner_label: 'Your fleet', raider_label: 'Computer fleet', owner_fleet: you.fleetId, sim: true,
    };
  };

  /* ── Time ──────────────────────────────────────────────────────────────── */

  Host.prototype.start = function () {
    if (this.running || this.finished) return;
    this.running = true;
    this.lastTick = Date.now();
    this.scheduleBlock(this.blockMs);
    this.scheduleAi();
    this.onChange();
  };
  Host.prototype.stop = function () {
    if (this.running) this.elapsed += Date.now() - this.lastTick;
    this.running = false;
    clearTimeout(this.blockTimer); this.blockTimer = null;
    clearTimeout(this.aiTimer); this.aiTimer = null;
    this.onChange();
  };
  Host.prototype.elapsedMs = function () { return this.elapsed + (this.running ? Date.now() - this.lastTick : 0); };
  Host.prototype.scheduleBlock = function (ms) {
    var self = this;
    clearTimeout(this.blockTimer);
    this.blockTimer = setTimeout(function () { self.block(); }, ms);
  };
  Host.prototype.scheduleAi = function () {
    var self = this;
    if (!this.ai) return;
    clearTimeout(this.aiTimer);
    var delay = this.ai.level.reactionMs * (0.75 + this.ai.rand() * 0.5);
    this.aiTimer = setTimeout(function () {
      if (!self.running) return;
      var msg = self.ai.decide(self.chain);
      if (msg) self.chain.submit(self.cpu.id, msg);
    }, delay);
  };

  /** One block: execute, then tell the Map Viewer what the stream would. */
  Host.prototype.block = function () {
    if (!this.running) return;
    var chain = this.chain, self = this;
    var b = chain.produceBlock();
    this.emit('raid-block', { height: b.height });
    var rows = [];
    var now = new Date();
    var stamp = { date: now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate()), time: pad(now.getHours()) + ':' + pad(now.getMinutes()) + ':' + pad(now.getSeconds()) };
    b.txs.forEach(function (tx) {
      if (!tx.ok) {
        if (tx.signer === self.you.id) self.emit('raid-tx', { transactionHash: tx.hash, status: 'failed', code: 1, error: tx.error });
        return;
      }
      tx.events.forEach(function (e) {
        if (e.category === 'struct_attack') {
          var d = e.detail;
          self.emit('raid-attacks', { generation: self.generation, attacks: [{
            at_ms: now.getTime(), attacker_id: d.attackerStructId, attacker_type: d.attackerStructType,
            attacker_ambit: d.attackerStructOperatingAmbit, weapon: d.weaponSystem, recoil: d.recoilDamage || 0,
            attacker_health_before: d.attackerHealthBefore, attacker_health_after: d.attackerHealthAfter,
            pdc_damage_to_attacker: false, pdc_damage: 0, pdc_destroyed_attacker: false,
            shots: d.eventAttackShotDetail,
          }] });
        } else {
          self.emit('raid-delta', { category: e.category, subject: e.subject, detail: e.detail });
        }
        var actor = e.category === 'struct_attack' ? e.detail.attackerPlayerId
          : e.category === 'raid_status' ? (chain.fleets[e.detail.fleet_id] || {}).owner
          : (chain.structs[e.detail.struct_id || e.detail.defender_struct_id] || {}).owner;
        var target = e.category === 'struct_attack' ? ((e.detail.eventAttackShotDetail || [])[0] || {}).targetPlayerId : null;
        rows.push({ time: stamp.time, date: stamp.date, actor: actor || null, target: target || null,
          category: e.category, kind: activityKind(e.category), detail: describeActivity(e.category, e.detail), block: b.height });
      });
    });
    if (rows.length) {
      this.logRows = this.logRows.concat(rows).slice(-400);
      this.emit('raid-log', { generation: this.generation, rows: rows, players: this.players() });
    }
    this.emit('raid-snapshot', { generation: this.generation, snapshot: this.snapshot() });
    this.lastBlock = b;
    var left = chain.fleetsAtBattle();
    if (left.length < 2) {
      var youFleet = chain.players[this.you.id].fleetId;
      this.finished = { winner: left.length === 0 ? 'draw' : left[0] === youFleet ? 'you' : 'cpu', height: b.height };
      this.stop();
      return;
    }
    this.onChange(b);
    this.scheduleBlock(this.blockMs);
    this.scheduleAi();
  };

  root.SimulatorHost = Host;
})(typeof window !== 'undefined' ? window : globalThis);
