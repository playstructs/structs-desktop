/* The achievement catalogue and its two shapes.
 *
 * `window.StructsAchievements` — the DEFINITIONS (what an achievement is
 * called, which glyph carries it, which ladder it climbs) and two renderers:
 *
 *   rack(data, opts)    the ribbon rack   — tiles, earned-forward
 *   matrix(data, opts)  the hull tally    — 22 hulls × what each one has done
 *
 * Both read one payload: `terminal_achievements(player)`.
 *
 * ── Absence is not zero ────────────────────────────────────────────────────
 * A counter missing from `counters` was never observed and draws "—". A
 * counter present with the value 0 is a real zero and draws "0". The Rust side
 * keeps that distinction deliberately (see `mcp/achievements.rs`), and losing
 * it here would put a confident "0 KILLS" on the card of a player whose combat
 * history we simply cannot read yet. This is the same trap that once wrote
 * false zeros through every Game Stats sparkline.
 *
 * ── No explanations ────────────────────────────────────────────────────────
 * There is no description field and there is not going to be one. The player
 * is an expert; the name and the number are the whole story. What the
 * cheatsheet adds when a tile is opened is STATE — tier, next threshold,
 * source — never a tutorial.
 *
 * Hand-authored, top level in frontend/ (css/, js/, img/ are wiped by sync.sh).
 */
(function (root) {
  'use strict';

  var U = root.StructsUnits;
  var P = root.StructsPlayerCard && root.StructsPlayerCard.parts;

  function el(tag, cls, txt) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (txt != null) n.textContent = txt;
    return n;
  }
  function icon(cls, size) { return el('i', 'sui-icon sui-icon-' + (size || 'md') + ' ' + cls); }
  function badge(text, mod) {
    if (P) return P.badge({ text: text, mod: mod });
    return el('span', 'sui-badge sui-mod-' + (mod || 'default'), text);
  }

  /* ── The tier ladder ───────────────────────────────────────────────────────
   *
   * THIS IS THE TUNING SURFACE. It is data, not control flow, precisely
   * because the right thresholds are not knowable before the thing is live:
   * 5,000 is a low bar for damage and an absurd one for Command Ship kills.
   * Change the numbers here and every tile, pip and badge follows; nothing
   * else in this file or in Rust knows what a tier is.
   *
   * Six rungs, drawn as six pips and numbered I–VI. Ladders for a resource
   * are in that resource's BASE units — grams for ore, ualpha for alpha —
   * because that is what the payload carries. */
  var LADDERS = {
    'default': [1, 10, 50, 250, 1000, 5000],
    // Rare by nature: a Command Ship kill is the deterministic raid-winning
    // lever, and nobody scores hundreds of them.
    'rare': [1, 3, 10, 25, 50, 100],
    // Damage accumulates in ones and twos per shot (every fleet weapon is
    // 2 dmg / 1 shot), so a thousand is a career, not a week.
    'damage': [10, 100, 500, 2000, 10000, 50000],
    // Grams.  1Kg · 10Kg · 100Kg · 1,000Kg · 10,000Kg · 100,000Kg
    'ore': [1e3, 1e4, 1e5, 1e6, 1e7, 1e8],
    // ualpha.  1g · 10g · 100g · 1Kg · 10Kg · 100Kg
    'alpha': [1e6, 1e7, 1e8, 1e9, 1e10, 1e11],
    // A feat is binary: you have done it or you have not.
    'feat': [1],
  };
  var ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI'];

  /* ── The catalogue ─────────────────────────────────────────────────────────
   *
   * `key`   matches a counter emitted by `mcp/achievements.rs` — the test
   *         suite fails if either side grows a name the other does not know.
   * `name`  the full name, used by the record line and the cheatsheet.
   * `short` what fits on a 96px tile. Abbreviating on the fly produced
   *         "CMD SHIPS D…", and breaking mid-word produced "REPELLE / D",
   *         which in an all-caps face reads as two words. Two names is the
   *         honest cost of a grid.
   * `art`   struct art (img/structs/<slug>/) wins over `icon` when present.
   * `fmt`   'int' | 'ore' | 'alpha' — which of the game's ladders prints it.
   */
  var FAMILIES = [
    { key: 'raid', label: 'Raiding', icon: 'icon-raid', rows: [
      { key: 'raids_launched', name: 'Raids launched', short: 'Launched', icon: 'icon-raid' },
      { key: 'raids_won', name: 'Raids won', short: 'Won', icon: 'sui-icon-attacker' },
      { key: 'ore_seized', name: 'Ore seized in raids', short: 'Seized', icon: 'sui-icon-alpha-ore', fmt: 'ore', ladder: 'ore' },
      { key: 'raids_repelled', name: 'Raids repelled', short: 'Repelled', icon: 'sui-icon-defended' },
      { key: 'ore_forfeited', name: 'Ore lost to raiders', short: 'Forfeited', icon: 'icon-outgoing', fmt: 'ore', ladder: 'ore' },
      { key: 'feat_breach_kill', name: 'Killed a raider mid-breach', short: 'Breach kill', icon: 'icon-planetary-shield', ladder: 'feat' },
      { key: 'feat_dry_well', name: 'Won a raid that took nothing', short: 'Dry well', icon: 'icon-undiscovered-ore', ladder: 'feat' },
    ] },
    { key: 'war', label: 'Destruction', icon: 'icon-wreckage', rows: [
      { key: 'kills', name: 'Structs destroyed', short: 'Kills', icon: 'sui-icon-destroyed' },
      { key: 'cmd_kills', name: 'CMD Ships destroyed', short: 'CMD kills', art: 'cmd-ship', ladder: 'rare' },
      { key: 'fleet_kills', name: 'Fleet structs destroyed', short: 'Fleet kills', icon: 'icon-fleet-tile' },
      { key: 'ground_kills', name: 'Planetary structs destroyed', short: 'Ground kills', icon: 'icon-planet' },
      { key: 'counter_kills', name: 'Destroyed by counter-attack', short: 'Counters', icon: 'icon-counter', ladder: 'rare' },
      { key: 'defender_kills', name: 'Destroyed by planetary defenses', short: 'PDC kills', icon: 'sui-icon-defender-counter', ladder: 'rare' },
      { key: 'structs_lost', name: 'Structs lost', short: 'Lost', icon: 'icon-wreckage' },
      { key: 'feat_double_tap', name: 'Killed a CMD Ship twice on one planet', short: 'Double tap', art: 'cmd-ship', ladder: 'feat' },
      { key: 'feat_payback', name: 'Beat a player who beat you', short: 'Payback', icon: 'sui-icon-enemy-indicator', ladder: 'feat' },
    ] },
    { key: 'gun', label: 'Gunnery', icon: 'icon-dmg', rows: [
      { key: 'shots_fired', name: 'Shots fired', short: 'Shots', icon: 'icon-dmg', ladder: 'damage' },
      { key: 'damage_dealt', name: 'Damage dealt', short: 'Dealt', icon: 'icon-dmg', ladder: 'damage' },
      { key: 'smart_damage', name: 'Damage with smart weapons', short: 'Smart dmg', icon: 'icon-smart-weapon', ladder: 'damage' },
      { key: 'ballistic_damage', name: 'Damage with ballistic weapons', short: 'Ballistic dmg', icon: 'icon-ballistic-weapon', ladder: 'damage' },
      { key: 'armour_piercer', name: 'Pierced ablative armour', short: 'Piercer', icon: 'sui-icon-armour', ladder: 'feat' },
      { key: 'damage_from_land', name: 'Damage from land-based structs', short: 'From land', icon: 'sui-icon-land', ladder: 'damage' },
      { key: 'damage_from_water', name: 'Damage from water-based structs', short: 'From water', icon: 'sui-icon-water', ladder: 'damage' },
      { key: 'damage_from_air', name: 'Damage from air-based structs', short: 'From air', icon: 'sui-icon-air', ladder: 'damage' },
      { key: 'damage_from_space', name: 'Damage from space-based structs', short: 'From space', icon: 'sui-icon-space', ladder: 'damage' },
    ] },
    { key: 'def', label: 'Defense', icon: 'icon-defend', rows: [
      { key: 'damage_taken', name: 'Damage taken', short: 'Taken', icon: 'icon-incoming', ladder: 'damage' },
      { key: 'damage_blocked', name: 'Damage blocked by defenders', short: 'Blocked', icon: 'sui-icon-defender-block', ladder: 'damage' },
      { key: 'damage_absorbed', name: 'Damage absorbed by armour', short: 'Absorbed', icon: 'sui-icon-armour', ladder: 'damage' },
      { key: 'evaded_jam', name: 'Damage evaded by signal jamming', short: 'Jammed', icon: 'icon-signal-jam', ladder: 'damage' },
      { key: 'evaded_stealth', name: 'Damage evaded by stealth', short: 'Unseen', icon: 'icon-stealth', ladder: 'damage' },
      { key: 'evaded_other', name: 'Damage evaded otherwise', short: 'Evaded', icon: 'sui-icon-deflector-shield', ladder: 'damage' },
    ] },
    { key: 'econ', label: 'Industry', icon: 'icon-refine', rows: [
      { key: 'ore_mined', name: 'Ore extracted', short: 'Extracted', art: 'extractor', fmt: 'ore', ladder: 'ore' },
      { key: 'alpha_refined', name: 'Alpha refined', short: 'Refined', art: 'refinery', fmt: 'alpha', ladder: 'alpha' },
      { key: 'alpha_infused', name: 'Alpha infused', short: 'Infused', icon: 'sui-icon-alpha-matter', fmt: 'alpha', ladder: 'alpha' },
      { key: 'planets_drained', name: 'Planets drained dry', short: 'Drained', icon: 'icon-mine', ladder: 'rare' },
    ] },
    { key: 'build', label: 'Construction', icon: 'icon-deploy', rows: [
      { key: 'structs_built', name: 'Structs built', short: 'Built', icon: 'sui-icon-deployed-structs' },
    ] },
  ];

  // Flat index, so a lookup by key is not a nested scan.
  var BY_KEY = {};
  FAMILIES.forEach(function (f) {
    f.rows.forEach(function (r) { r.family = f.key; BY_KEY[r.key] = r; });
  });

  function ladderFor(row) { return LADDERS[(row && row.ladder) || 'default'] || LADDERS['default']; }

  /* Which rung a value stands on, and how far up the next one it is.
   * `tier` 0 means not started. `next` null means the top rung is reached. */
  function tierOf(value, row) {
    var ladder = ladderFor(row);
    if (value == null) return { tier: 0, next: ladder[0], floor: 0, frac: 0, unknown: true, rungs: ladder.length };
    var t = 0;
    for (var i = 0; i < ladder.length; i++) if (value >= ladder[i]) t = i + 1;
    var floor = t ? ladder[t - 1] : 0;
    var next = t < ladder.length ? ladder[t] : null;
    var frac = next == null ? 1 : Math.max(0, Math.min(1, (value - floor) / (next - floor)));
    return { tier: t, next: next, floor: floor, frac: frac, unknown: false, rungs: ladder.length };
  }

  /* The game's own ladders. Ore is counted in GRAMS and alpha in ualpha
   * (micrograms) — the two ledger columns really are on different scales, and
   * `amount_p` is the precise one. A bare count is just a count. */
  function fmtValue(value, row) {
    if (value == null) return '—';
    if (!U) return String(value);
    if (row && row.fmt === 'ore') return U.fmtOre(value);
    if (row && row.fmt === 'alpha') return U.fmtAlpha(value);
    return Number(value).toLocaleString('en-US');
  }

  function readCounter(data, key) {
    var c = (data && data.counters) || {};
    // `in`, not truthiness: 0 is an answer and undefined is not.
    return Object.prototype.hasOwnProperty.call(c, key) ? Number(c[key]) : null;
  }

  var ART = 'img/structs/';
  /* Nine struct types draw from a directory that is not their slugified name.
   * board-pages.js owns the same map; the test suite pins the two together. */
  var ART_DIRS = {
    'command ship': 'cmd-ship', 'ore extractor': 'extractor', 'refinery': 'refinery',
    'planetary defense cannon': 'pdc', 'surface-to-air missile launcher': 'sam-launcher',
    'signal jammer': 'jamming-sat', 'orbital shield': 'orb-shield', 'ore bunker': 'ore-bunker',
    'mobile artillery': 'mobile-artillery',
  };
  function artSlug(name) {
    var k = String(name || '').toLowerCase().trim();
    if (ART_DIRS[k]) return ART_DIRS[k];
    return k.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  }
  function artImg(slug) {
    var i = el('img');
    i.src = ART + slug + '/' + slug + '-struct-base.png';
    i.alt = '';
    return i;
  }

  function emblem(row, state) {
    var e = el('span', 'ac-em' + (state ? ' ac-' + state : ''));
    if (row.art) e.appendChild(artImg(row.art));
    else e.appendChild(icon(row.icon || 'icon-unknown'));
    return e;
  }

  // ── the cheatsheet: the game's own, opened under a tile ────────────────────
  //
  // `SUICheatsheetRenderer`'s markup, built by hand because our windows cannot
  // import from the webapp submodule. State only: tier, next rung, where the
  // figure came from.
  function sheet(row, value, reading, source) {
    var cs = el('div', 'sui-cheatsheet sui-theme-player');
    cs.appendChild(el('div', 'sui-cheatsheet-top-frame'));

    var title = el('div', 'sui-cheatsheet-title');
    title.appendChild(el('div', 'sui-cheatsheet-title-text', row.name));
    var costs = el('div', 'sui-cheatsheet-costs');
    var cost = el('div', 'sui-cheatsheet-cost');
    cost.appendChild(el('span', null, fmtValue(value, row)));
    costs.appendChild(cost);
    title.appendChild(costs);
    cs.appendChild(title);

    var content = el('div', 'sui-cheatsheet-content');
    var section = el('div', 'sui-cheatsheet-property-section');
    var props = [
      ['icon-success', 'Tier', reading.tier ? ROMAN[reading.tier] + ' / ' + ROMAN[reading.rungs] : '—'],
      ['icon-in-progress', 'Next', reading.unknown ? '—'
        : (reading.next == null ? 'max' : fmtValue(reading.next, row))],
      ['icon-info', 'Source', source || 'guild'],
    ];
    props.forEach(function (p) {
      var pr = el('div', 'sui-cheatsheet-property');
      var ic = el('div', 'sui-cheatsheet-property-icon');
      ic.appendChild(icon(p[0]));
      pr.appendChild(ic);
      var info = el('div', 'sui-cheatsheet-property-info');
      info.appendChild(el('span', null, p[1]));
      info.appendChild(el('div', null, p[2]));
      pr.appendChild(info);
      section.appendChild(pr);
    });
    content.appendChild(section);
    cs.appendChild(content);
    return cs;
  }

  // ── B · the ribbon rack ────────────────────────────────────────────────────

  function pips(reading) {
    var w = el('div', 'ac-rib-pips');
    for (var i = 0; i < reading.rungs; i++) {
      w.appendChild(el('span', 'ac-pip' + (i < reading.tier ? ' on' : '')));
    }
    return w;
  }

  function tile(row, value, source) {
    var reading = tierOf(value, row);
    var state = reading.unknown ? 'unknown' : (reading.tier === 0 ? 'locked' : (reading.next == null ? 'max' : ''));
    var t = el('div', 'ac-rib' + (state ? ' is-' + state : ''));
    t.setAttribute('data-key', row.key);
    t.tabIndex = 0;
    // The hover title carries the FULL name; the tile shows the short one.
    t.title = row.name + (reading.unknown ? ' — not recorded yet' : '');
    t.appendChild(emblem(row, reading.unknown || reading.tier === 0 ? 'locked' : (reading.next == null ? 'done' : '')));
    t.appendChild(el('div', 'ac-rib-v', fmtValue(value, row)));
    t.appendChild(pips(reading));
    t.appendChild(el('div', 'ac-rib-n sui-text-label', row.short || row.name));

    function open() {
      var rack = t.parentNode;
      if (!rack) return;
      var already = rack.querySelector('.ac-sheet');
      var mine = already && already.previousSibling === t;
      if (already) already.parentNode.removeChild(already);
      if (mine) { t.classList.remove('is-open'); return; }
      var prev = rack.querySelector('.ac-rib.is-open');
      if (prev) prev.classList.remove('is-open');
      var host = el('div', 'ac-sheet');
      host.appendChild(sheet(row, value, reading, source));
      rack.insertBefore(host, t.nextSibling);
      t.classList.add('is-open');
    }
    t.addEventListener('click', open);
    t.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
    });
    return t;
  }

  function sectionHead(family, earned, total) {
    var h = el('div', 'ac-sec-h');
    h.appendChild(icon(family.icon, 'sm'));
    h.appendChild(el('span', 'sui-text-label', family.label));
    h.appendChild(el('span', 'ac-sec-n sui-text-label', earned + ' / ' + total));
    return h;
  }

  function statTile(label, value, cls) {
    var t = el('div', 'ac-stat' + (cls ? ' ' + cls : ''));
    t.appendChild(el('div', 'ac-stat-v', value));
    t.appendChild(el('div', 'ac-stat-l sui-text-label', label));
    return t;
  }

  /* Where a counter came from, for the cheatsheet's Source line. Coarse on
   * purpose: the player wants to know whether a number is the guild's record
   * or a gap, not which HTTP route answered. */
  function sourceOf(row, data) {
    var combat = ((data && data.coverage) || {}).combat;
    var isCombat = ['raid', 'war', 'gun', 'def'].indexOf(row.family) >= 0
      && ['raids_launched', 'ore_seized', 'ore_forfeited', 'raids_landed'].indexOf(row.key) < 0;
    if (isCombat) return combat === 'full' ? 'activity' : 'not recorded';
    return 'guild';
  }

  /**
   * The ribbon rack. `data` is a `terminal_achievements` payload.
   * opts: { onlyFamily?: 'raid'|… }
   */
  function rack(data, opts) {
    opts = opts || {};
    var wrap = el('div', 'ac-rack-wrap');

    var earned = 0, total = 0, progressing = 0, unknown = 0;
    FAMILIES.forEach(function (f) {
      f.rows.forEach(function (r) {
        total++;
        var v = readCounter(data, r.key);
        if (v == null) unknown++;
        else if (v > 0) { earned++; if (tierOf(v, r).next != null) progressing++; }
      });
    });

    var strip = el('div', 'ac-strip');
    strip.appendChild(statTile('earned', earned + ' / ' + total, 'ac-live'));
    strip.appendChild(statTile('climbing', String(progressing)));
    if (unknown) strip.appendChild(statTile('not recorded', String(unknown), 'ac-muted'));
    wrap.appendChild(strip);

    var combat = ((data && data.coverage) || {}).combat;
    if (combat && combat !== 'full') {
      // State, not an explainer: the guild has no per-player activity route,
      // so those tiles are blank rather than wrong.
      var note = el('div', 'ac-gap sui-text-label');
      note.appendChild(icon('icon-unknown', 'sm'));
      note.appendChild(el('span', null, 'combat not recorded'));
      wrap.appendChild(note);
    }

    FAMILIES.filter(function (f) { return !opts.onlyFamily || f.key === opts.onlyFamily; })
      .forEach(function (f) {
        var got = f.rows.filter(function (r) { var v = readCounter(data, r.key); return v != null && v > 0; }).length;
        wrap.appendChild(sectionHead(f, got, f.rows.length));
        var grid = el('div', 'ac-rack');
        f.rows.forEach(function (r) {
          grid.appendChild(tile(r, readCounter(data, r.key), sourceOf(r, data)));
        });
        wrap.appendChild(grid);
      });
    return wrap;
  }

  // ── C · the hull tally ─────────────────────────────────────────────────────

  /* Five readings per hull, and they are five different achievements.
   * `kills` and `destroyed` are the two sides of the same rows — what my hull
   * of this type killed, and how many enemy hulls of this type I killed — and
   * collapsing them would make one of the two achievements unanswerable. */
  var COLUMNS = [
    { key: 'built', label: 'built' },
    { key: 'kills', label: 'kills', hot: true },
    { key: 'damage', label: 'damage' },
    { key: 'destroyed', label: 'destroyed' },
    { key: 'lost', label: 'lost' },
  ];

  function cellValue(v) { return v == null ? '—' : Number(v).toLocaleString('en-US'); }

  /**
   * The hull matrix. opts: { columns?: ['kills', …] } — a one-wide card asks
   * for a single column rather than scrolling five off the edge.
   */
  function matrix(data, opts) {
    opts = opts || {};
    var cols = COLUMNS.filter(function (c) {
      return !opts.columns || opts.columns.indexOf(c.key) >= 0;
    });
    var hulls = (data && data.hulls) || [];
    var wrap = el('div', 'ac-mx-wrap');

    var totals = {};
    cols.forEach(function (c) { totals[c.key] = null; });
    hulls.forEach(function (h) {
      cols.forEach(function (c) {
        if (h[c.key] != null) totals[c.key] = (totals[c.key] || 0) + Number(h[c.key]);
      });
    });
    var strip = el('div', 'ac-strip');
    cols.forEach(function (c) { strip.appendChild(statTile(c.label, cellValue(totals[c.key]))); });
    wrap.appendChild(strip);

    if (!hulls.length) {
      var empty = el('div', 'ac-gap sui-text-label');
      empty.appendChild(icon('icon-unknown', 'sm'));
      empty.appendChild(el('span', null, 'no hull record'));
      wrap.appendChild(empty);
      return wrap;
    }

    var tbl = el('table', 'ac-mx');
    var thead = el('thead'), hr = el('tr');
    hr.appendChild(el('th', 'sui-text-label', 'Hull'));
    cols.forEach(function (c) { hr.appendChild(el('th', 'ac-num sui-text-label', c.label)); });
    thead.appendChild(hr);
    tbl.appendChild(thead);

    var tb = el('tbody');
    hulls.forEach(function (h) {
      var tr = el('tr');
      var td = el('td');
      var id = el('div', 'ac-mx-id');
      id.appendChild(artImg(artSlug(h.type)));
      id.appendChild(el('span', 'ac-nm', h.type));
      // The tier badge rides the KILL count: "Defeat [#] Structs with [Struct]"
      // is the achievement this row is really about.
      var reading = tierOf(h.kills == null ? null : Number(h.kills), BY_KEY.kills);
      if (reading.tier) id.appendChild(badge(ROMAN[reading.tier], reading.next == null ? 'solid' : 'default'));
      td.appendChild(id);
      tr.appendChild(td);
      cols.forEach(function (c) {
        var v = h[c.key];
        var cls = 'ac-num' + (v == null || Number(v) === 0 ? ' ac-zero' : (c.hot ? ' ac-hot' : ''));
        tr.appendChild(el('td', cls, cellValue(v)));
      });
      tb.appendChild(tr);
    });
    tbl.appendChild(tb);
    wrap.appendChild(tbl);

    // The ambit strip: where the killing happened. Given how much of the
    // roster cannot shoot into water at all, this is a real reading and not
    // decoration.
    var amb = (data && data.ambits) || {};
    var kills = amb.kills || {};
    var names = ['land', 'water', 'air', 'space'];
    var any = names.some(function (a) { return kills[a] != null; });
    if (any) {
      var strip2 = el('div', 'ac-strip ac-ambits');
      names.forEach(function (a) {
        var t = statTile('killed in ' + a, cellValue(kills[a] == null ? null : Number(kills[a])));
        t.querySelector('.ac-stat-v').appendChild(icon('sui-icon-' + a, 'sm'));
        strip2.appendChild(t);
      });
      wrap.appendChild(strip2);
    }
    return wrap;
  }

  root.StructsAchievements = {
    LADDERS: LADDERS, FAMILIES: FAMILIES, BY_KEY: BY_KEY, COLUMNS: COLUMNS, ROMAN: ROMAN,
    tierOf: tierOf, fmtValue: fmtValue, readCounter: readCounter, artSlug: artSlug,
    sourceOf: sourceOf, tile: tile, sheet: sheet, rack: rack, matrix: matrix,
  };
})(window);
