/* The game's own unit ladders, in one place.
 *
 * Alpha is measured in ualpha — MICROGRAMS — and the game shows it on a metric
 * ladder: "9.4Kg", never "9400 Alpha". Any window that invents its own
 * presentation is telling the player a different story about the same number
 * from the one every other screen tells, which is how a transfer window ends up
 * saying "9400" beside an inventory page saying "9.4Kg".
 *
 * Lives outside board.js so the small windows can use it without loading the
 * console. board.js delegates to it rather than keeping a second copy: two
 * ladders are two ladders whatever the intention.
 */
(function (root) {
  'use strict';

  var SCALES = {
    // milliwatts in
    power: [[16, 1e18, 'TW'], [10, 1e9, 'MW'], [6, 1e6, 'KW'], [3, 1e3, 'W'], [0, 1, 'mW']],
    // ualpha in (1 g Alpha = 1e6 ualpha — "Alpha" and "gram" are the same unit)
    alpha: [[16, 1e18, 'Tg'], [10, 1e9, 'Kg'], [6, 1e6, 'g'], [3, 1e3, 'mg'], [0, 1, 'μg']],
    // grams in
    ore: [[12, 1e12, 'Tg'], [4, 1e3, 'Kg'], [0, 1, 'g']],
  };

  // Trim to at most 2 decimals without leaving a trailing ".0"/".00" — exactly
  // what the game's `toFixed(2).replace(/\.?0+$/,'')` does.
  function trim2(v) {
    return v.toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
  }

  function stepFor(raw, ladder) {
    var len = String(Math.abs(Math.trunc(Number(raw)))).length;
    for (var i = 0; i < ladder.length; i++) {
      if (len >= ladder[i][0]) return ladder[i];
    }
    return ladder[ladder.length - 1];
  }

  function fmtScale(raw, kind) {
    if (raw == null || isNaN(raw)) return '—';
    var step = stepFor(raw, SCALES[kind]);
    return trim2(Number(raw) / step[1]) + step[2];
  }

  /* The reverse: what the player typed, in base units.
   *
   * Accepts the units the ladder PRINTS, so a number copied off any other
   * screen can be pasted back in — "9.4Kg" reads as 9.4Kg rather than as a
   * syntax error. A bare number is the ladder's own base display unit (grams
   * for Alpha), because that is the unit a player who types no suffix means.
   *
   * Case matters where the game's own labels distinguish it: `mg` and `Mg` are
   * a factor of a billion apart. Returns null for anything it cannot read,
   * NEVER 0 — a caller must be able to tell "nothing typed yet" from "zero",
   * and silently reading junk as zero is how a form ends up looking ready.
   */
  function parse(text, kind) {
    var ladder = SCALES[kind];
    if (!ladder) return null;
    var s = String(text == null ? '' : text).trim().replace(/,/g, '');
    if (!s) return null;
    var m = /^(-?\d*\.?\d+)\s*([A-Za-zμ]*)$/.exec(s);
    if (!m) return null;
    var n = Number(m[1]);
    if (!isFinite(n)) return null;
    var suffix = m[2];
    if (!suffix) {
      // No unit: the ladder's display unit — 'g' for alpha and ore, 'mW' for
      // power. That is the rung the game treats as the plain name of the thing.
      var base = kind === 'power' ? 'mW' : 'g';
      return Math.round(n * mulFor(base, ladder));
    }
    var mul = mulFor(suffix, ladder);
    return mul == null ? null : Math.round(n * mul);
  }

  function mulFor(suffix, ladder) {
    for (var i = 0; i < ladder.length; i++) {
      if (ladder[i][2] === suffix) return ladder[i][1];
    }
    return null;
  }

  /* TIME, on one ladder.
   *
   * There were three, with three different answers for the same instant: an
   * `ago` that stepped at 90s and 90m and never reached days (three days ago
   * read as "72h"), a `duration` that stepped at 60s and 60m and did reach
   * them, and an `fmtEta` with no seconds rung at all — which reported a
   * five-second cycle as "1m". Same class as the alpha ladder above: two
   * presentations of one number tell the player two different stories.
   *
   * Options, because the CALLERS differ even though the ladder must not:
   *   empty — what to print when there is no number. Pass `null` to render
   *           nothing at all; a caller that omits the row entirely on absence
   *           must not be handed a dash to display.
   *   zero  — what to print at or below zero ("now" for an ETA, but a
   *           duration of zero really is "0s").
   */
  function fmtDuration(seconds, opts) {
    opts = opts || {};
    // `'empty' in opts`, not `opts.empty || '—'`: a caller that deliberately
    // wants NOTHING passes null, and `||` would silently hand it the dash.
    var blank = 'empty' in opts ? opts.empty : '—';
    if (seconds == null || isNaN(seconds)) return blank;
    var s = Math.max(0, Number(seconds));
    if (s <= 0 && 'zero' in opts) return opts.zero;
    if (s < 60) return Math.round(s) + 's';
    if (s < 3600) return Math.round(s / 60) + 'm';
    if (s < 86400) return trim1(s / 3600) + 'h';
    return Math.round(s / 86400) + 'd';
  }

  function trim1(v) { return v.toFixed(1).replace(/\.0$/, ''); }

  /* How long ago, from an absolute timestamp.
   *
   * The same ladder, reached through a subtraction — not a second one. `ago`
   * was where the missing days rung actually hurt: a console that runs for
   * days is exactly where "72h" turns up.
   */
  function fmtAgo(ms, opts) {
    if (!ms) return (opts && 'empty' in opts) ? opts.empty : '—';
    return fmtDuration((Date.now() - ms) / 1000, opts);
  }

  root.StructsUnits = {
    SCALES: SCALES,
    trim2: trim2,
    stepFor: stepFor,
    fmtScale: fmtScale,
    parse: parse,
    fmtAlpha: function (ualpha) { return fmtScale(ualpha, 'alpha'); },
    fmtWatts: function (mw) { return fmtScale(mw, 'power'); },
    fmtOre: function (g) { return fmtScale(g, 'ore'); },
    parseAlpha: function (t) { return parse(t, 'alpha'); },
    fmtDuration: fmtDuration,
    fmtAgo: fmtAgo,
  };
})(typeof window !== 'undefined' ? window : globalThis);
