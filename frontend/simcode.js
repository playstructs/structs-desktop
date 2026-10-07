/* Simulator challenge codes — the `/sim/<code>` in https://structs.app/sim/<code>.
 *
 * A copy of structs-app's src/simcode.js (the site decodes what this encodes),
 * as a classic script for the simulator window. The byte layout, base64url:
 *
 *   0      version (1)
 *   1      difficulty (bits 0-1: easy|difficult|hard) · block time (bit 2: 2 s|6 s)
 *   2, 3   charge: player, computer (0-30)
 *   4      seed length n (0-60), then n bytes of printable ASCII
 *   …      unit count, then 2 bytes per unit, big-endian:
 *            side 1 · type 5 · ambit 2 · slot 2 · protects 6 (0 = none, else index + 1)
 *
 * Decoding returns the simulator's version-3 layout JSON, so `validate()`
 * stays the judge of what is legal. scripts/harness-tests/simcode.test.mjs
 * pins this copy to the site's: same code for the same battle, both ways.
 */
(function (root) {
  'use strict';
  var VERSION = 1;
  var LEVELS = ['easy', 'difficult', 'hard'];
  var BLOCK_MS = [2000, 6000];
  var SIDES = ['player', 'computer'];
  var AMBITS = ['space', 'air', 'land', 'water'];
  var COMMAND_TYPE = 1;
  var MAX_CHARGE = 30;
  var MAX_UNITS = 34;
  var BASE = 'https://structs.app/sim/';

  function unitId(side, type, ambit, slot) { return side + '-' + (type === COMMAND_TYPE ? 'cmd' : ambit + '-' + slot); }
  function toB64url(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function fromB64url(str) {
    var s = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
    var out = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }
  function charge(n) {
    if (!Number.isInteger(n) || n < 0 || n > MAX_CHARGE) throw Error('unsupported charge');
    return n;
  }

  /** Layout config (as the simulator holds it) → compact code. Throws on anything unrepresentable. */
  function encode(c) {
    var lvl = LEVELS.indexOf(c.difficulty), blk = BLOCK_MS.indexOf(c.blockMs);
    if (lvl < 0 || blk < 0) throw Error('unsupported difficulty or block time');
    var seed = String(c.seed || '');
    if (seed.length > 60 || !/^[\x21-\x7e]*$/.test(seed)) throw Error('unsupported seed');
    var units = c.units || [];
    if (units.length > MAX_UNITS) throw Error('too many units');
    var index = {};
    units.forEach(function (u, i) { index[u.id] = i; });
    var out = [VERSION, lvl | (blk << 2), charge(c.charge.player), charge(c.charge.computer), seed.length];
    for (var k = 0; k < seed.length; k++) out.push(seed.charCodeAt(k));
    out.push(units.length);
    units.forEach(function (u) {
      var side = SIDES.indexOf(u.side), ambit = AMBITS.indexOf(u.ambit);
      var prot = u.protects == null ? 0 : (index.hasOwnProperty(u.protects) ? index[u.protects] + 1 : -1);
      if (side < 0 || ambit < 0 || !(u.type >= 1 && u.type <= 31) || !(u.slot >= 0 && u.slot <= 3) || prot < 0) throw Error('unsupported unit');
      var v = (side << 15) | (u.type << 10) | (ambit << 8) | (u.slot << 6) | prot;
      out.push(v >> 8, v & 0xff);
    });
    return toB64url(out);
  }

  /** Compact code → version-3 layout JSON, or null if it is not a code. */
  function decode(code) {
    var b;
    try { b = fromB64url(String(code)); } catch (e) { return null; }
    var i = 0;
    var next = function () { if (i >= b.length) throw Error('short'); return b[i++]; };
    try {
      if (next() !== VERSION) return null;
      var flags = next();
      var difficulty = LEVELS[flags & 3], blockMs = BLOCK_MS[(flags >> 2) & 1];
      var player = next(), computer = next();
      if (!difficulty || player > MAX_CHARGE || computer > MAX_CHARGE) return null;
      var n = next();
      if (n > 60) return null;
      var seed = '';
      for (var k = 0; k < n; k++) {
        var ch = next();
        if (ch < 0x21 || ch > 0x7e) return null;
        seed += String.fromCharCode(ch);
      }
      var count = next();
      if (count > MAX_UNITS) return null;
      var raw = [];
      for (var m = 0; m < count; m++) {
        var v = (next() << 8) | next();
        raw.push({ side: SIDES[v >> 15], type: (v >> 10) & 31, ambit: AMBITS[(v >> 8) & 3], slot: (v >> 6) & 3, prot: v & 63 });
      }
      if (i !== b.length) return null;
      var units = raw.map(function (u) {
        return { id: unitId(u.side, u.type, u.ambit, u.slot), side: u.side, type: u.type, ambit: u.ambit, slot: u.slot, protects: null };
      });
      raw.forEach(function (u, k) {
        if (u.prot === 0) return;
        var target = units[u.prot - 1];
        if (!target) throw Error('bad protects');
        units[k].protects = target.id;
      });
      return { version: 3, seed: seed, difficulty: difficulty, blockMs: blockMs, charge: { player: player, computer: computer }, units: units };
    } catch (e) {
      return null;
    }
  }

  /** The shareable link for a battle config. */
  function link(c) { return BASE + encode(c); }

  /** Pull a code out of whatever was pasted: a structs.app or structs:// sim
   * link, or a bare code. Null when the text is none of those. */
  function codeFrom(text) {
    var t = String(text || '').trim();
    // A result link (…/sim/<code>/<result>) pastes as the battle it was played on.
    var m = /^(?:https?:\/\/(?:www\.)?structs\.app|structs:\/)\/sim\/([A-Za-z0-9_-]{4,2000})(?:\/[A-Za-z0-9_-]{1,64})?\/?(?:[?#].*)?$/i.exec(t);
    if (m) return m[1];
    return /^[A-Za-z0-9_-]{4,2000}$/.test(t) ? t : null;
  }

  /* ── Results: https://structs.app/sim/<code>/<result> ─────────────────────
   * How a battle went, appended to the battle's own link as a second path
   * segment (spec: proposals/sim-results-link.md). 19 bytes, 26 characters:
   *
   *   0      version (1)
   *   1      outcome: bits 0-1 winner (0 player · 1 computer · 2 draw),
   *          bit 2 forfeit, bits 3-4 stalemate (0 none · 1 moves · 2 quiet)
   *   2      rules revision (the simulator's combat + computer tuning)
   *   3, 4   blocks played, uint16
   *   5, 6   battle seconds, uint16
   *   7-12   player:   lost, attacks, damage, evaded, blocked, counter damage
   *   13-18  computer: the same six
   *
   * Numbers saturate (255 / 65535) rather than wrap. Self-reported: a result
   * is a claim, not a proof — battles are not replayable. */
  var RESULT_VERSION = 1;
  var RULES_REVISION = 1;            // 2026-10-07: land opening, tuned computer
  var WINNERS = ['player', 'computer', 'draw'];
  var STALEMATES = [null, 'moves', 'quiet'];
  var TALLY = ['lost', 'attacks', 'damage', 'evaded', 'blocked', 'countered'];
  function u8(n) { n = Math.floor(Number(n) || 0); return n < 0 ? 0 : n > 255 ? 255 : n; }
  function u16(n) { n = Math.floor(Number(n) || 0); return n < 0 ? 0 : n > 65535 ? 65535 : n; }

  function encodeResult(r) {
    var w = WINNERS.indexOf(r.winner), st = STALEMATES.indexOf(r.stalemate || null);
    if (w < 0 || st < 0) throw Error('unsupported result');
    var out = [RESULT_VERSION, w | (r.forfeit ? 4 : 0) | (st << 3), u8(r.revision == null ? RULES_REVISION : r.revision)];
    var blocks = u16(r.blocks), secs = u16(r.seconds);
    out.push(blocks >> 8, blocks & 0xff, secs >> 8, secs & 0xff);
    ['player', 'computer'].forEach(function (side) {
      var t = (r.stats && r.stats[side]) || {};
      TALLY.forEach(function (k) { out.push(u8(t[k])); });
    });
    return toB64url(out);
  }
  function decodeResult(code) {
    var b;
    try { b = fromB64url(String(code)); } catch (e) { return null; }
    if (b.length !== 19 || b[0] !== RESULT_VERSION || (b[1] & 0xe0)) return null;
    var winner = WINNERS[b[1] & 3], stalemate = STALEMATES[(b[1] >> 3) & 3], forfeit = !!(b[1] & 4);
    if (!winner || stalemate === undefined) return null;
    if (forfeit && winner !== 'computer') return null;
    if (stalemate && winner !== 'draw') return null;
    var stats = {}, i = 7;
    ['player', 'computer'].forEach(function (side) { stats[side] = {}; TALLY.forEach(function (k) { stats[side][k] = b[i++]; }); });
    return { version: RESULT_VERSION, winner: winner, forfeit: forfeit, stalemate: stalemate, revision: b[2],
      blocks: (b[3] << 8) | b[4], seconds: (b[5] << 8) | b[6], stats: stats };
  }
  function resultLink(config, result) { return link(config) + '/' + encodeResult(result); }

  root.StructsSimCode = { VERSION: VERSION, BASE: BASE, encode: encode, decode: decode, link: link, codeFrom: codeFrom,
    RESULT_VERSION: RESULT_VERSION, RULES_REVISION: RULES_REVISION, encodeResult: encodeResult, decodeResult: decodeResult, resultLink: resultLink };
})(typeof window !== 'undefined' ? window : globalThis);
