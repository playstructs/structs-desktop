// GAME STATS — the whole-universe dashboard (pop-out only).
//
// Team Ops answers "how is OUR fleet doing"; this page answers "what does the
// galaxy look like": player and guild leaderboards plus game-wide totals and
// per-block trends. It is registered as a hidden Command section so the router
// can resolve the solo view (`board.html?view=gamestats`), but it never shows
// a nav entry — the door is the Game Stats button on the game's Debug tab.
//
// Data contract (Rust `mcp::game_stats`):
//  - pull:  `mcp_game_stats_snapshot` → the full cache, always the first paint
//  - push:  `game-stats-update` — {tier:'block', height, point} every game
//           block, {tier:'fast'|'heavy', snapshot} after sweeps, and
//           {tier:'sweeping'|'idle'} around them
//  - belt-and-braces: the raw `grass-event` block tick also bumps the height,
//           so the header stays live even if a stats push is dropped.
(function () {
  'use strict';
  var Board = window.Board;
  var H = Board.helpers;

  var state = {
    booted: false,
    snap: null,
    metric: { key: 'alpha', dir: -1 }, // sortControl contract
    renderTimer: null,
    lastRender: 0,
  };

  var SERIES_CAP = 720; // mirror of the Rust ring

  // Alpha is the default board (wealth is the game's headline score). Values
  // come from /api/leaderboard/player (alpha_value = balance + infused, the
  // server's denom-correct ranking) with the bank module as fallback — never
  // the roster/search "alpha" columns, which sum every denom and let
  // guild-token holders masquerade as alpha whales.
  var METRICS = [
    { key: 'alpha', label: 'alpha', icon: 'sui-icon-alpha-matter', fmt: function (v) { return H.fmtAlpha(v); } },
    { key: 'structs_load', label: 'structs load', icon: 'sui-icon-deployed-structs', fmt: function (v) { return H.fmtWatts(v); } },
    { key: 'ore', label: 'ore', icon: 'sui-icon-alpha-ore', fmt: function (v) { return H.fmtOre(v); } },
  ];
  function metricDef(key) {
    for (var i = 0; i < METRICS.length; i++) if (METRICS[i].key === key) return METRICS[i];
    return METRICS[0];
  }

  // ── Charts ────────────────────────────────────────────────────────────────
  // SUI has no graph component, so this is the one hand-rolled visual. What
  // it draws is fixed by the dataviz method: a 2px line per series, a zero
  // baseline for counts (a chart that autoscales 4→5 to its full height
  // turns noise into a swing), the min/max/last figures at the edges, time
  // ticks along the baseline, gaps broken rather than bridged, and a hover
  // layer — crosshair plus one tooltip listing every series at that X. Text
  // lives in HTML beside the stretched SVG so it never distorts, and it wears
  // text tokens; only the marks carry the series colour.
  var SVG_NS = 'http://www.w3.org/2000/svg';
  var CHART_H = 56;

  function svgEl(tag, attrs) {
    var n = document.createElementNS(SVG_NS, tag);
    Object.keys(attrs || {}).forEach(function (k) { n.setAttribute(k, String(attrs[k])); });
    return n;
  }
  function finite(v) { return typeof v === 'number' && isFinite(v); }
  function fmtDefault(v) { return H.fmtNum ? H.fmtNum(v) : String(v); }

  /* Minutes-ago captions for a per-block window: three ticks, the last one
   * "now". Blocks run 5.30 s, so 720 of them are the last hour. */
  /* One ladder for every "how long ago" on this page: units.js's, reached
   * through a block count. `zero: 'now'` is the current block. */
  function blocksAgo(blocks, secs) {
    var t = window.StructsUnits.fmtDuration(blocks * (secs || 5.3), { zero: 'now' });
    return t === 'now' ? t : '−' + t;
  }
  function blockTicks(n) {
    if (n < 2) return [];
    var secs = 5.3;
    function ago(i) { return blocksAgo(n - 1 - i, secs); }
    return [{ at: 0, text: ago(0) }, { at: 0.5, text: ago(Math.floor((n - 1) / 2)) }, { at: 1, text: 'now' }];
  }

  /* spec: { series: [{ values, stroke, label }], zero, fmt, ticks: [{at 0..1, text}] }
   * Returns a .gs-chart element. `zero` pins the floor at 0 for counts. */
  function chart(spec) {
    var series = (spec.series || []).filter(function (sr) { return sr && sr.values; });
    var fmt = spec.fmt || fmtDefault;
    var box = H.el('div', 'gs-chart');
    var n = 0;
    series.forEach(function (sr) { n = Math.max(n, sr.values.length); });
    var nums = [];
    series.forEach(function (sr) { sr.values.forEach(function (v) { if (finite(v)) nums.push(v); }); });
    function collecting() {
      box.appendChild(H.el('div', 'gs-chart-empty fstat-l', 'collecting…'));
      return box;
    }
    if (nums.length < 2) return collecting();
    var min = Math.min.apply(null, nums), max = Math.max.apply(null, nums);
    if (spec.zero && min > 0) min = 0;
    /* A count series gets a floor on its CEILING too (`least`): one raid in
     * an hour is a single block at 1, and on a band of 0..1 that is a spike
     * the full height of the plot. On 0..2 it is half, which is what one
     * event looks like beside a busy hour. A flat line still needs a band. */
    var least = spec.least != null ? spec.least : (spec.zero ? 2 : 0);
    if (max < min + least) max = min + least;
    if (max === min) max = min + 1;
    var span = max - min;

    // Legend for ≥ 2 series: identity never rides on colour alone.
    if (series.length > 1) {
      var legend = H.el('div', 'gs-legend');
      series.forEach(function (sr) {
        var item = H.el('span', 'gs-legend-item');
        var key = H.el('span', 'gs-legend-key');
        key.style.background = sr.stroke;
        item.appendChild(key);
        item.appendChild(H.el('span', 'fstat-l', sr.label || ''));
        legend.appendChild(item);
      });
      box.appendChild(legend);
    }

    var plot = H.el('div', 'gs-plot');
    // A grid: gutters and the plot area on the first row, the time ticks on
    // the second under the plot only — so the floor figure sits on the
    // baseline, not under the tick row.
    var gutterL = H.el('div', 'gs-gutter');
    var area = H.el('div', 'gs-area');
    var gutterR = H.el('div', 'gs-gutter gs-gutter-r');
    var ticks = H.el('div', 'gs-ticks');
    plot.appendChild(gutterL); plot.appendChild(area); plot.appendChild(gutterR); plot.appendChild(ticks);
    var w = 900, h = spec.height || CHART_H;
    var svg = svgEl('svg', { viewBox: '0 0 ' + w + ' ' + h, preserveAspectRatio: 'none' });
    svg.style.cssText = 'display:block;width:100%;height:' + h + 'px;';
    // Recessive hairlines: the baseline and the top of the band.
    svg.appendChild(svgEl('line', { x1: 0, x2: w, y1: h - 1, y2: h - 1, stroke: 'var(--border-subtle)', 'stroke-width': 0.5 }));
    svg.appendChild(svgEl('line', { x1: 0, x2: w, y1: 1, y2: 1, stroke: 'var(--border-subtle)', 'stroke-width': 0.5, 'stroke-opacity': 0.5 }));
    var step = n > 1 ? w / (n - 1) : w;
    function yOf(v) { return h - 3 - ((v - min) / span) * (h - 6); }
    var drewAny = false;
    series.forEach(function (sr) {
      /* Gaps BREAK the line; they are not drawn through and not drawn as
       * zero. A gap means "no sample": a zero invents a crash, a bridge
       * invents readings nobody took. It also keeps NaN out of `d` — one
       * non-finite value invalidates the whole path silently. */
      var d = '', pen = 'M', drew = false;
      sr.values.forEach(function (v, i) {
        if (!finite(v)) { pen = 'M'; return; }
        d += pen + (i * step).toFixed(1) + ' ' + yOf(v).toFixed(1);
        if (pen === 'L') drew = true;
        pen = 'L';
      });
      if (!drew) return;
      drewAny = true;
      svg.appendChild(svgEl('path', { d: d, fill: 'none', stroke: sr.stroke || 'var(--text-player-primary)',
        'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round', 'vector-effect': 'non-scaling-stroke' }));
    });
    if (!drewAny) { box.innerHTML = ''; return collecting(); }
    // The crosshair, hidden until the pointer is over the plot.
    var cross = svgEl('line', { x1: 0, x2: 0, y1: 0, y2: h, stroke: 'var(--text-hint)', 'stroke-width': 1, 'vector-effect': 'non-scaling-stroke' });
    cross.setAttribute('class', 'gs-cross');
    cross.style.display = 'none';
    svg.appendChild(cross);
    area.appendChild(svg);

    // Axis figures live in the gutters beside the plot, in HTML, so the
    // pixel face stays crisp and never sits on top of the line.
    gutterL.appendChild(H.el('div', 'gs-axis gs-axis-top fstat-l', fmt(max)));
    gutterL.appendChild(H.el('div', 'gs-axis gs-axis-bot fstat-l', fmt(min)));
    // The last reading of the first series, at the right edge.
    var lastVal = null;
    for (var i = series[0].values.length - 1; i >= 0; i--) { if (finite(series[0].values[i])) { lastVal = series[0].values[i]; break; } }
    var lastEl = H.el('div', 'gs-axis gs-axis-last ops-val', lastVal == null ? '' : fmt(lastVal));
    // Where the line ENDS, not the top corner: a "0" floating at the top of
    // a chart whose line sits on the floor reads as the wrong number.
    if (lastVal != null) lastEl.style.top = yOf(lastVal).toFixed(0) + 'px';
    gutterR.appendChild(lastEl);
    box.appendChild(plot);

    (spec.ticks || blockTicks(n)).forEach(function (t) {
      var tk = H.el('span', 'gs-tick fstat-l', t.text);
      tk.style.left = (t.at * 100) + '%';
      ticks.appendChild(tk);
    });

    // Hover: the crosshair finds the X, one tooltip lists every series.
    var tip = H.el('div', 'gs-tip');
    tip.hidden = true;
    area.appendChild(tip);
    function indexAt(clientX) {
      var r = area.getBoundingClientRect();
      if (!r.width) return 0;
      var f = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
      return Math.round(f * (n - 1));
    }
    function showAt(i) {
      cross.setAttribute('x1', String(i * step)); cross.setAttribute('x2', String(i * step));
      cross.style.display = '';
      tip.innerHTML = '';
      var head = H.el('div', 'gs-tip-x sui-text-hint', spec.xLabel ? spec.xLabel(i) : ('block ' + (spec.heights && spec.heights[i] != null ? H.fmtInt(spec.heights[i]) : blocksAgo(n - 1 - i))));
      tip.appendChild(head);
      series.forEach(function (sr) {
        var row = H.el('div', 'gs-tip-row');
        var key = H.el('span', 'gs-legend-key'); key.style.background = sr.stroke;
        row.appendChild(key);
        row.appendChild(H.el('span', 'ops-val', finite(sr.values[i]) ? fmt(sr.values[i]) : '—'));
        if (sr.label) row.appendChild(H.el('span', 'sui-text-hint', sr.label));
        tip.appendChild(row);
      });
      tip.hidden = false;
      var f = n > 1 ? i / (n - 1) : 0;
      tip.style.left = (f * 100) + '%';
      tip.classList.toggle('gs-tip-flip', f > 0.6);
    }
    function hide() { cross.style.display = 'none'; tip.hidden = true; }
    plot.addEventListener('pointermove', function (e) { showAt(indexAt(e.clientX)); });
    plot.addEventListener('pointerleave', hide);
    plot.tabIndex = 0;
    plot.addEventListener('focus', function () { showAt(n - 1); });
    plot.addEventListener('blur', hide);
    box._chart = { showAt: showAt, min: min, max: max, n: n };
    return box;
  }

  /* One series, the old name: the test hooks and the block-tick path use it. */
  function sparkline(values, strokeVar, opts) {
    var o = opts || {};
    return chart({ series: [{ values: values, stroke: strokeVar }], zero: o.zero, fmt: o.fmt, ticks: o.ticks });
  }

  /* A single ratio against a limit: a meter, filled from the same ramp. */
  function meter(label, part, whole, fmt) {
    var box = H.el('div', 'gs-meter');
    var cap = H.el('div', 'gs-meter-cap');
    cap.appendChild(H.el('span', 'fstat-l', label));
    var f = fmt || H.fmtInt;
    cap.appendChild(H.el('span', 'ops-val', (part == null || whole == null) ? '—' : f(part) + ' / ' + f(whole)));
    box.appendChild(cap);
    var track = H.el('div', 'gs-meter-track');
    var fill = H.el('div', 'gs-meter-fill');
    var pct = (part != null && whole > 0) ? Math.max(0, Math.min(100, part / whole * 100)) : 0;
    fill.style.width = pct.toFixed(1) + '%';
    fill.title = pct.toFixed(0) + '%';
    track.appendChild(fill);
    box.appendChild(track);
    return box;
  }

  /* Columns for a small ordered distribution (the battery levels): ≤ 24px
   * thick, rounded data-end, square at the baseline, value on the cap. */
  function columns(values, labels, stroke) {
    var box = H.el('div', 'gs-cols');
    var max = Math.max.apply(null, values.map(function (v) { return finite(v) ? v : 0; }).concat([1]));
    values.forEach(function (v, i) {
      var col = H.el('div', 'gs-col');
      col.appendChild(H.el('div', 'gs-col-v', finite(v) ? H.fmtInt(v) : '—'));
      var bar = H.el('div', 'gs-col-bar');
      bar.style.height = (finite(v) ? Math.max(2, v / max * 40) : 2).toFixed(0) + 'px';
      bar.style.background = stroke || 'var(--text-player-primary)';
      col.appendChild(bar);
      col.appendChild(H.el('div', 'gs-col-l sui-text-hint', labels[i]));
      col.title = labels[i] + ': ' + (finite(v) ? H.fmtInt(v) : '—');
      box.appendChild(col);
    });
    return box;
  }

  /* Samples for one series, with NULL for "not known at that block".
   *
   * Was `Number(p[key]) || 0`, which turned every unknown into a hard zero —
   * and, incidentally, every genuine zero into one too, so the two were
   * indistinguishable. The producer now sends null for a total it has not
   * swept yet (see `opt_num` in game_stats.rs); this keeps the distinction
   * instead of collapsing it, and the sparkline breaks its line across it.
   */
  function seriesValues(key) {
    var s = (state.snap && state.snap.series) || [];
    return s.map(function (p) {
      if (p == null || p[key] == null) return null;
      var n = Number(p[key]);
      return isFinite(n) ? n : null;
    });
  }

  // ── Renderers ─────────────────────────────────────────────────────────────
  function num(v) { var n = Number(v); return isFinite(n) ? n : null; }

  // The whole header lives in one titled card, mirroring Diagnostics'
  // SYSTEM HEALTH container — a bare tile strip floating over the page read
  // as unfinished next to the carded sections below it.
  function universeCard(t) {
    var body = H.el('div');
    var strip = H.el('div', 'hstrip');
    strip.appendChild(H.statTile('Block', H.fmtInt(state.snap.block_height), null, 'ok'));
    strip.appendChild(H.statTile('Players', H.fmtInt(num(t.players)), 'sui-icon-players'));
    strip.appendChild(H.statTile('Guilds', H.fmtInt(num(t.guilds))));
    strip.appendChild(H.statTile(['Planets', 'complete / found'],
      H.fmtInt(num(t.planets_complete)) + ' / ' + H.fmtInt(num(t.planets_total))));
    strip.appendChild(H.statTile('Structs', H.fmtInt(num(t.structs_total)), 'sui-icon-deployed-structs'));
    // A bounded recent-window count: the all-time figure (96k and counting)
    // is history, not news.
    strip.appendChild(H.statTile(['Destroyed', 'last 24h'], H.fmtInt(num(t.destroyed_24h)), null,
      num(t.destroyed_24h) > 0 ? 'live' : 'muted'));
    strip.appendChild(H.statTile(['Fleets', 'away / total'],
      H.fmtInt(num(t.fleets_away)) + ' / ' + H.fmtInt(num(t.fleets_total))));
    strip.appendChild(H.statTile('Live Raids', H.fmtInt(num(t.raids_active)), 'icon-raid',
      num(t.raids_active) > 0 ? 'live' : null));
    strip.appendChild(H.statTile('Work Queue', H.fmtInt(num(t.work_queue)), 'icon-in-progress'));
    strip.appendChild(H.statTile(['Alpha Infused', 'all reactors'],
      H.fmtAlpha(num(t.total_alpha)), 'sui-icon-alpha-matter'));
    // Same grid-rollup numbers as the ENERGY GRID card — one source of truth,
    // and the same vocabulary: draw vs delivered, never draw+routed (which
    // double-counts the re-export leg and reads as an over-capacity grid).
    var gridCap = num(t.player_capacity);
    strip.appendChild(H.statTile(['Grid', 'draw / delivered'],
      gridCap == null ? '—'
        : H.fmtWatts(num(t.structs_draw) || 0) + ' / ' + H.fmtWatts(gridCap),
      'sui-icon-energy'));
    strip.appendChild(H.statTile(['Stored Ore', 'stealable'], H.fmtOre(num(t.stored_ore)), 'sui-icon-alpha-ore'));
    strip.appendChild(H.statTile(['Ore In Ground', 'unmined'], H.fmtOre(num(t.ground_ore)), null, 'muted'));
    body.appendChild(strip);
    // No sweep/refresh chatter up here — "sweeping"/"swept Xm ago" is engine
    // vocabulary, and a player reads it as something being wrong. Sections
    // that have no data yet say Loading…; a hit table cap gets one quiet
    // hint because an undercount presented as a total would be a lie.
    if (state.snap.truncated) {
      var hint = H.el('div', 'sui-text-hint', 'counts are still catching up to the full galaxy');
      hint.style.marginTop = '6px';
      body.appendChild(hint);
    }
    var c = H.card('UNIVERSE', body);
    c.id = 'gs-universe';
    c.style.marginBottom = '10px';
    return c;
  }

  function playersCard() {
    var body = H.el('div');
    var def = metricDef(state.metric.key);
    var toolbar = H.el('div');
    toolbar.style.cssText =
      'display:flex;justify-content:flex-end;margin-bottom:var(--spacing-md);';
    toolbar.appendChild(H.sortControl(
      METRICS.map(function (m) { return { key: m.key, label: m.label }; }),
      state.metric,
      renderNow
    ));
    body.appendChild(toolbar);
    var rows = (state.snap.players_top && state.snap.players_top[def.key]) || [];
    if (!rows.length) {
      body.appendChild(H.stateBlock('info', 'Loading…'));
    } else {
      var table = H.resultTable();
      // dir contract from sortControl: -1 = descending (rank 1 first).
      var ordered = state.metric.dir < 0 ? rows : rows.slice().reverse();
      ordered.forEach(function (r) {
        // A leaderboard is a list of PEOPLE. Who is actually around, and a
        // way to reach them, is what turns a table of rivals into something
        // you can act on — the same two affordances the roster carries, on
        // the same players. One shared card draws both (playercard.js).
        var attrs = r.pfp_attrs;
        if (attrs && typeof attrs !== 'string') attrs = JSON.stringify(attrs);
        table.appendChild(window.StructsPlayerCard.row({
          id: r.player_id,
          prefix: '#' + r.rank,
          name: r.username || r.player_id,
          presence: Board.presenceDot && Board.presenceDot(r.player_id),
          pfp: attrs,
          // The guild on its own line: tag first (short, what people say),
          // then the name, so neither crowds the id.
          guild: ((r.tag ? '[' + r.tag + '] ' : '') + (r.guild_name || '')).trim() || null,
          readings: [{ value: def.fmt(num(r.value)), icon: def.icon, title: def.label }],
        }, {
          // Watch their planet / follow their fleet when the row carries the
          // ids, then the two ways to reach them.
          actions: (Board.watchActions ? Board.watchActions(r) : [])
            .concat(Board.reachActions ? Board.reachActions(r) : []),
        }));
      });
      body.appendChild(table);
    }
    return H.card('BEST PLAYERS', body);
  }

  function guildsCard() {
    var body = H.el('div');
    var rows = state.snap.guilds || [];
    // Power figures join in from the heavy tier's grid rollup — the guild
    // rows themselves are fast-tier and deliberately carry none.
    var energyByGuild = {};
    (state.snap.guild_energy || []).forEach(function (e) { energyByGuild[e.guild_id] = e; });
    if (!rows.length) {
      body.appendChild(H.stateBlock('info', 'Loading…'));
    } else {
      // Guild ROWS (guildcard.js) — the same aligned line the player
      // leaderboard uses, rank first, in the same result-table container.
      var table = H.resultTable();
      rows.forEach(function (g, i) {
        var e = energyByGuild[g.guild_id];
        table.appendChild(window.StructsGuildCard.row({
          id: g.guild_id,
          prefix: '#' + (i + 1),
          name: g.name || null,
          tag: g.tag || null,
          logo: g.logo || null,
          readings: [
            { value: H.fmtInt(num(g.members)), icon: 'sui-icon-players', title: 'Members' },
            { value: H.fmtAlpha(num(g.alpha)), icon: 'sui-icon-alpha-matter', title: 'Alpha infused' },
            { value: e ? H.fmtWatts(num(e.capacity)) : '—', icon: 'sui-icon-energy', title: 'Capacity' },
            { value: H.fmtInt(num(g.planets_complete)), icon: 'sui-icon-md icon-planet', title: 'Planets' },
          ],
        }, {
          actions: Board.guildActions ? Board.guildActions(g) : [],
        }));
      });
      body.appendChild(table);
    }
    return H.card('BEST GUILDS', body);
  }

  /* Each trend is a chart spec over the per-block ring. `keys` names one
   * series per entry (a legend appears for two or more); `zero` pins the
   * floor for counts. The colours are SUI's own semantic tokens — the only
   * palette this window may use — assigned in a fixed order and never
   * cycled: teal, lavender, amber, then red for danger. */
  var TEAL = 'var(--text-player-primary)', LAVENDER = 'var(--accent-secondary)', AMBER = 'var(--text-warning)', RED = 'var(--text-enemy-primary)', HINT = 'var(--text-hint)';
  var TRENDS = [
    // Real transactions, from the block itself (null while nobody is looking).
    { label: 'chain transactions / block', zero: true, least: 4, keys: [{ key: 'chain_tx', stroke: TEAL }] },
    { label: 'our transactions / block', zero: true, least: 4,
      keys: [{ key: 'our_tx', stroke: TEAL, label: 'signed' }, { key: 'gate_cap', stroke: HINT, label: 'gate cap' }] },
    { label: 'grass frames / block', zero: true, least: 4,
      keys: [{ key: 'frames_planet', stroke: TEAL, label: 'planet' }, { key: 'frames_grid', stroke: LAVENDER, label: 'grid' }, { key: 'frames_inventory', stroke: AMBER, label: 'inventory' }] },
    { label: 'combat / block', zero: true, keys: [{ key: 'combat', stroke: RED }] },
    { label: 'live raids', zero: true, keys: [{ key: 'raids', stroke: AMBER }] },
    { label: 'alpha transfers / block', zero: true, keys: [{ key: 'transfers', stroke: LAVENDER }] },
    // Steps between heavy sweeps rather than moving per block — still the
    // right place to see the galaxy powering up over an hour.
    { label: 'structs draw', keys: [{ key: 'draw', stroke: LAVENDER }], fmt: function (v) { return H.fmtWatts(v); } },
  ];
  function trendChart(t) {
    return chart({
      series: t.keys.map(function (k) { return { values: seriesValues(k.key), stroke: k.stroke, label: k.label }; }),
      zero: t.zero, fmt: t.fmt, least: t.least,
      heights: ((state.snap && state.snap.series) || []).map(function (p) { return p && p.height; }),
    });
  }

  // ── The headline: is the galaxy alive? ──────────────────────────────────
  // One hero figure — players who acted in the last hour — read straight off
  // the perception snapshot's lastAction store, with the day, the roster and
  // the newcomers beside it, and the week's shape beneath.
  function livenessCard(t) {
    var body = H.el('div');
    var hero = H.el('div', 'gs-hero');
    var big = H.el('div', 'gs-hero-v', t.live_1h == null ? '—' : H.fmtInt(num(t.live_1h)));
    hero.appendChild(big);
    hero.appendChild(H.el('div', 'gs-hero-l', 'players acted in the last hour'));
    body.appendChild(hero);
    var ring = (state.snap && state.snap.liveness) || [];
    var strip = H.el('div', 'hstrip gs-strip');
    strip.appendChild(H.statTile(['Active', 'last 24h'], H.fmtInt(num(t.live_24h)), null, 'ok'));
    strip.appendChild(H.statTile(['Known', 'players'], H.fmtInt(num(t.players_known)), 'sui-icon-players'));
    /* Newcomers are the highest player id now against the highest id back
     * then, so they need a sample from back then. Until the hourly ring is a
     * day deep the tile shows the same difference over the span it HAS —
     * "last 3h" — rather than a dash for a day. */
    var fresh = newcomers(t, ring);
    strip.appendChild(H.statTile(['New', fresh.span], fresh.count == null ? '—' : H.fmtInt(fresh.count), null,
      fresh.count > 0 ? 'live' : null));
    strip.appendChild(H.statTile(['New', 'last 7 days'], t.new_players_7d == null ? '—' : H.fmtInt(num(t.new_players_7d))));
    body.appendChild(strip);
    var line = H.el('div', 'gs-line');
    var cap = H.el('div', 'gs-cap');
    cap.appendChild(H.el('span', 'fstat-l', 'players active per hour — 7 days'));
    line.appendChild(cap);
    var ticks = [{ at: 0, text: '−7d' }, { at: 0.5, text: '−3.5d' }, { at: 1, text: 'now' }];
    if (ring.length < LIVENESS_MIN) {
      line.appendChild(chart({ series: [{ values: [] }] }));
    } else {
      // One axis: the per-day count is five times the per-hour one and would
      // squash it to a flat line; the tile above carries the day.
      line.appendChild(chart({
        series: [{ values: ring.map(function (r) { return num(r.live_1h); }), stroke: TEAL }],
        zero: true, ticks: ticks, height: HERO_CHART_H,
        xLabel: function (i) { var r = ring[i]; return r && r.ts_ms ? new Date(r.ts_ms).toLocaleString() : ''; },
      }));
    }
    body.appendChild(line);
    var c = H.card('GALAXY LIVENESS', body);
    c.id = 'gs-liveness';
    c.style.marginBottom = 'var(--spacing-lg)';
    return c;
  }
  var LIVENESS_MIN = 2;
  var HERO_CHART_H = 88;
  function newcomers(t, ring) {
    if (t.new_players_24h != null) return { count: num(t.new_players_24h), span: 'last 24h' };
    var first = ring.length ? ring[0] : null;
    var now = num(t.max_player_index), then = first ? num(first.max_index) : null;
    if (now == null || then == null || !first.ts_ms) return { count: null, span: 'last 24h' };
    var age = (Date.now() - num(first.ts_ms)) / 1000;
    if (age < 60) return { count: null, span: 'last 24h' };
    return { count: Math.max(0, now - then), span: 'last ' + window.StructsUnits.fmtDuration(age) };
  }

  function trendLine(label, node) {
    var line = H.el('div', 'gs-line');
    var cap = H.el('div', 'gs-cap');
    cap.appendChild(H.el('span', 'fstat-l', label));
    line.appendChild(cap);
    line.appendChild(node);
    return line;
  }
  var GRID_CSS = 'display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:0 var(--spacing-xl);align-items:start;';

  // ── Our engine: what this app is doing with the chain ──────────────────
  function engineCard(t) {
    var body = H.el('div');
    var grid = H.el('div'); grid.style.cssText = GRID_CSS;
    grid.appendChild(trendLine('proofs solved / block', chart({ series: [{ values: seriesValues('proofs'), stroke: TEAL }], zero: true })));
    grid.appendChild(trendLine('proofs waiting for ripeness', chart({ series: [{ values: seriesValues('pool_pending'), stroke: LAVENDER }], zero: true })));
    grid.appendChild(trendLine('proofs grinding', chart({ series: [{ values: seriesValues('pool_running'), stroke: TEAL }], zero: true })));
    grid.appendChild(trendLine('signing queue depth', chart({ series: [{ values: seriesValues('gate_queued'), stroke: AMBER, label: 'queued' }, { values: seriesValues('gate_in_flight'), stroke: TEAL, label: 'in flight' }], zero: true })));
    body.appendChild(grid);
    // The roster's batteries: how many of OUR players sit at each of the
    // HUD's five charge levels (0 = spent this block).
    var levels = Array.isArray(t.charge_levels) ? t.charge_levels.map(num) : null;
    var bat = H.el('div', 'gs-line');
    var cap = H.el('div', 'gs-cap');
    cap.appendChild(H.el('span', 'fstat-l', 'our players by battery level'));
    bat.appendChild(cap);
    bat.appendChild(levels ? columns(levels, ['0', '1', '2', '3', '4', '5'], TEAL) : H.el('div', 'gs-chart-empty fstat-l', 'collecting…'));
    body.appendChild(bat);
    var c = H.card('OUR ENGINE', body);
    c.id = 'gs-engine';
    return c;
  }

  // ── Ore economy ────────────────────────────────────────────────────────
  function oreCard(t) {
    var body = H.el('div');
    var withOre = num(t.planets_with_ore), exhausted = num(t.planets_exhausted);
    body.appendChild(meter('planets with ore left', withOre, withOre != null && exhausted != null ? withOre + exhausted : null));
    var strip = H.el('div', 'hstrip gs-strip');
    strip.appendChild(H.statTile(['Rigs', 'mining'], H.fmtInt(num(t.rigs_mining)), 'icon-mine'));
    strip.appendChild(H.statTile(['Rigs', 'refining'], H.fmtInt(num(t.rigs_refining)), 'icon-refine'));
    strip.appendChild(H.statTile(['Stored Ore', 'stealable'], H.fmtOre(num(t.stored_ore)), 'sui-icon-alpha-ore'));
    body.appendChild(strip);
    body.appendChild(trendLine('ore cycles completing / block', chart({
      series: [{ values: seriesValues('mine_starts'), stroke: TEAL, label: 'mine' }, { values: seriesValues('refine_starts'), stroke: LAVENDER, label: 'refine' }],
      zero: true,
    })));
    var c = H.card('ORE ECONOMY', body);
    c.id = 'gs-ore';
    return c;
  }

  // ── Raid pressure ──────────────────────────────────────────────────────
  function raidCard(t) {
    var body = H.el('div');
    var strip = H.el('div', 'hstrip gs-strip');
    strip.appendChild(H.statTile(['Fleets', 'away'], H.fmtInt(num(t.fleets_away_now)), 'sui-icon-md icon-fleet-tile', num(t.fleets_away_now) > 0 ? 'live' : null));
    strip.appendChild(H.statTile(['Fleets', 'on station'], H.fmtInt(num(t.fleets_on_station))));
    strip.appendChild(H.statTile('Live Raids', H.fmtInt(num(t.raids_active)), 'icon-raid', num(t.raids_active) > 0 ? 'live' : null));
    var f = t.raid_funnel && typeof t.raid_funnel === 'object' ? t.raid_funnel : null;
    strip.appendChild(H.statTile(['Our funnel', 'scored → eligible'],
      f ? H.fmtInt(num(f.scored)) + ' → ' + H.fmtInt(num(f.eligible)) : '—', null, f && f.dispatching ? 'live' : 'muted'));
    if (f && f.top_gate && f.top_gate.gate) {
      strip.appendChild(H.statTile(['Top gate', String(f.top_gate.gate)], H.fmtInt(num(f.top_gate.count)), null, 'muted'));
    }
    body.appendChild(strip);
    body.appendChild(trendLine('raids armed / block', chart({ series: [{ values: seriesValues('raid_starts'), stroke: RED }], zero: true })));
    var c = H.card('RAID PRESSURE', body);
    c.id = 'gs-raids';
    return c;
  }
  // 7-day hourly galaxy totals from the server's LOCF aggregate — history
  // that survives app restarts, unlike the per-block ring. Older guild APIs
  // don't serve it; the section simply doesn't render then.
  var HISTORY_SERIES = [
    { key: 'ore', label: 'stored ore — 7 days', stroke: 'var(--text-player-primary)', fmt: function (v) { return H.fmtOre(v); } },
    { key: 'structs_load', label: 'structs draw — 7 days', stroke: 'var(--accent-secondary)', fmt: function (v) { return H.fmtWatts(v); } },
  ];
  function historyValues(key) {
    var h = state.snap && state.snap.history;
    var rows = h && h[key];
    if (!rows || !rows.length) return [];
    // Rows are {bucket, sum, avg, population, samples}; sum is null before
    // the first observation — skip leading nulls, keep the line honest.
    var out = [];
    rows.forEach(function (r) {
      var v = num(r.sum);
      if (v == null && !out.length) return;   // before first observation
      out.push(v == null ? (out.length ? out[out.length - 1] : 0) : v);
    });
    return out;
  }
  function buildHistory(body) {
    HISTORY_SERIES.forEach(function (t) {
      var vals = historyValues(t.key);
      if (vals.length < 2) return;
      var ticks = [{ at: 0, text: '−7d' }, { at: 0.5, text: '−3.5d' }, { at: 1, text: 'now' }];
      body.appendChild(trendLine(t.label, chart({ series: [{ values: vals, stroke: t.stroke }], fmt: t.fmt, ticks: ticks })));
    });
  }
  function trendsCard() {
    var body = H.el('div', null);
    body.id = 'gs-trends';
    buildTrends(body);
    return H.card('TRENDS — LAST HOUR OF BLOCKS' +
      (state.snap && state.snap.history ? ' · LAST 7 DAYS' : ''), body);
  }
  function buildTrends(body) {
    body.innerHTML = '';
    /* Two columns where there is room.
     *
     * Five stacked charts at 56px each plus their captions came to 420px —
     * most of a short window, before a single leaderboard row. They are
     * ambient context, not the headline, so they share the width instead of
     * owning the height.
     */
    body.style.cssText = 'display:grid;'
      + 'grid-template-columns:repeat(auto-fit,minmax(320px,1fr));'
      + 'gap:0 var(--spacing-xl);align-items:start;';
    TRENDS.forEach(function (t) {
      body.appendChild(trendLine(t.label, trendChart(t)));
    });
    // The 7-day server aggregates render after the per-block hour: freshest
    // context first, the week's shape beneath it.
    buildHistory(body);
  }

  function render() {
    state.lastRender = Date.now();
    return H.renderInto('gamestats-body', function (host) {
      if (!state.snap) {
        host.appendChild(H.stateBlock('info', 'Contacting the stats engine…'));
        return;
      }
      if (state.snap.auth_ok === false) {
        host.appendChild(H.stateBlock('error',
          'The Guild API needs your game session — log in to Structs first, then this window recovers on its own.'));
        return;
      }
      var totals = state.snap.totals || {};
      host.appendChild(livenessCard(totals));
      host.appendChild(universeCard(totals));

      // Trends stretch the full row — the sparklines are the best thing on
      // the page and cramped in a half column. They also sit above the
      // leaderboards so the scroll path never threads through the boards'
      // inner scrollbars.
      host.appendChild(trendsCard());
      var ops = H.el('div');
      ops.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fit,minmax(420px,1fr));gap:var(--spacing-lg);align-items:start;margin-bottom:var(--spacing-lg);';
      ops.appendChild(engineCard(totals));
      // Ore and raids stack in the second column: three cards in two columns
      // otherwise leave the third alone under a tall engine card, beside a
      // hole the height of it.
      var side = H.el('div');
      side.style.cssText = 'display:flex;flex-direction:column;gap:var(--spacing-lg);min-width:0;';
      side.appendChild(oreCard(totals));
      side.appendChild(raidCard(totals));
      ops.appendChild(side);
      host.appendChild(ops);

      var cols = H.el('div');
        /* 560px, not 420. A leaderboard row is a portrait, a name and four stat
         tiles; at 420 the grid made two 470px columns and five guild rows
         wrapped their stats onto a second line (96px tall against 58). The
         breakpoint has to be the width a ROW needs, not a round number — this
         is measured, and it has no token because a column breakpoint is not
         spacing. */
    cols.style.cssText = 'display:grid;'
      + 'grid-template-columns:repeat(auto-fit,minmax(560px,1fr));'
      + 'gap:var(--spacing-lg);align-items:start;';
      cols.appendChild(playersCard());
      cols.appendChild(guildsCard());
      host.appendChild(cols);
    });
  }

  // Full repaints are throttled: block ticks land every ~5s and sweeps push on
  // top of them; one render per second is plenty for numbers this size.
  function renderSoon() {
    if (state.renderTimer) return;
    var wait = Math.max(0, 1000 - (Date.now() - state.lastRender));
    state.renderTimer = setTimeout(function () {
      state.renderTimer = null;
      render();
    }, wait);
  }
  function renderNow() {
    if (state.renderTimer) { clearTimeout(state.renderTimer); state.renderTimer = null; }
    render();
  }

  // Cheap in-place updates for the per-block tick — no full repaint.
  function bumpBlock(height) {
    if (!state.snap) return;
    if (height) state.snap.block_height = height;
    var host = document.getElementById('gamestats-body');
    if (!host) return;
    // The Block tile is the first tile of the UNIVERSE strip.
    var universe = host.querySelector('#gs-universe .fstat');
    if (universe) {
      var v = universe.querySelector('.fstat-v');
      if (v) v.textContent = H.fmtInt(state.snap.block_height);
    }
  }

  function pull() {
    // Who is around, alongside the snapshot rather than before it. The
    // leaderboard must render whether or not Comms is signed in, so presence
    // can only ever add a dot to a row that already exists.
    if (Board.ensurePresence) Board.ensurePresence(function () { renderSoon(); });
    return Board.T.core.invoke('mcp_game_stats_snapshot').then(function (snap) {
      state.snap = snap;
    }).catch(function () {});
  }

  // Listeners + first pull are deferred to the first onEnter: onBoot fires in
  // EVERY board-family window, and Team Ops should not pay for a page it only
  // reaches through a hand-typed hash.
  function ensureBoot() {
    if (state.booted) return Promise.resolve();
    state.booted = true;
    window.StructsEvents.listen('game-stats-update', function (e) {
      var p = e && e.payload;
      if (!p || !state.snap) return;
      if (p.tier === 'block') {
        if (p.point) {
          state.snap.series = state.snap.series || [];
          state.snap.series.push(p.point);
          if (state.snap.series.length > SERIES_CAP) state.snap.series.shift();
          var trends = document.getElementById('gs-trends');
          if (trends) buildTrends(trends);
        }
        bumpBlock(p.height);
        return;
      }
      if (p.tier === 'fast' || p.tier === 'slow' || p.tier === 'heavy') {
        if (p.snapshot) state.snap = p.snapshot;
        renderSoon();
        return;
      }
      if (p.tier === 'sweeping' || p.tier === 'idle') {
        state.snap.sweeping = p.tier === 'sweeping';
        // Auth recovering (or breaking) mid-session repaints; the sweep state
        // itself is deliberately not surfaced — engine vocabulary.
        if (p.tier === 'idle' && typeof p.auth_ok === 'boolean' && p.auth_ok !== state.snap.auth_ok) {
          state.snap.auth_ok = p.auth_ok;
          renderSoon();
        }
      }
    });
    // Height liveness even if a stats push is ever dropped: the raw block
    // tick travels the same relay this window already receives.
    window.StructsEvents.listen('grass-event', function (e) {
      var ev = e && e.payload;
      if (!ev || ev.category !== 'block') return;
      var h = ev.detail && Number(ev.detail.height);
      if (h) bumpBlock(h);
    });
    return pull();
  }

  function enter() {
    return ensureBoot().then(renderNow);
  }

  // Test hooks. The two functions that turn samples into a picture are where
  // a chart can lie without erroring, so they are asserted directly on inputs
  // the fixture cannot produce — an all-gap series, a lone island sample.
  Board._gamestats = { sparkline: sparkline, chart: chart, meter: meter, columns: columns, seriesValues: seriesValues, state: state };

  Board.registerPage('gamestats', {
    onEnter: enter,
    // Safety-net convergence: re-pull the (local, cheap) snapshot in case a
    // push was missed. The real drive is the event stream above.
    refresh: function () { return state.booted ? pull().then(renderSoon) : Promise.resolve(); },
    cadenceMs: 30000,
  });

  // Late-registration self-heal. board.js defers init() with a 0ms timer and
  // trusts that it lands after every page script has parsed — but while the
  // parser is stalled FETCHING a later classic script, the event loop runs
  // timers, so route() can fire between board-pages.js and this file. When
  // that race is lost the page is already current with no renderer attached;
  // enter() is idempotent, so just run it now.
  if (Board.current === 'gamestats' && Board.T) enter();
})();
