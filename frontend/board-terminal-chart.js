// The chart card: any series the app can read, several at once, on panes.
//
// A chart is a list of series — `{source, metric, subject}` — and a window.
// Rust (`terminal_chart_series`) answers every series on ONE time grid, so
// this file only decides how to draw them:
//
//   panes   series that share a UNIT share a pane; a second unit is a second
//           pane under the first, with its own axis. Never a second y-axis on
//           one plot — two scales on one picture is the chart mistake that
//           makes every comparison a lie.
//   index   every series indexed to 100 at the first reading in the window,
//           on one pane, so things in different units can be compared by how
//           they MOVED.
//   mode    line · area · bars; scale linear · log.
//
// Saved charts live in Rust (`terminal_charts`): a name, an optional ⌘K word,
// the params. `CHART <name>` and the word both open one; a share code carries
// one to somebody else; `Alert` writes a watchlist rule on a series.
(function () {
  'use strict';
  var Board = window.Board, T = Board.Terminal, H = Board.helpers;
  var invoke = function (cmd, args) { return Board.T.core.invoke(cmd, args || {}); };

  // Fixed order, never cycled: a series keeps its colour when another is
  // removed. Six is the most one plot can carry and still be read.
  var STROKES = ['var(--text-player-primary)', 'var(--accent-secondary)', 'var(--text-warning)',
                 'var(--text-enemy-primary)', 'var(--accent-primary)', 'var(--text-body)'];
  var MAX_SERIES = 6;
  var WINDOWS = [
    { value: '3600', label: '1 hour' },
    { value: '21600', label: '6 hours' },
    { value: '86400', label: '24 hours' },
    { value: '604800', label: '7 days' },
    { value: '2592000', label: '30 days' },
  ];
  var MODES = [{ value: 'line', label: 'line' }, { value: 'area', label: 'area' }, { value: 'bars', label: 'bars' }];
  var SCALES = [{ value: 'linear', label: 'linear' }, { value: 'log', label: 'log' }];
  var INDEX = [{ value: '0', label: 'as measured' }, { value: '1', label: 'indexed to 100' }];
  var OBJECT_TYPES = ['planet', 'player', 'struct', 'fleet', 'reactor', 'substation', 'guild', 'infusion', 'allocation', 'provider', 'agreement'];

  // A rate or a ratio at the precision it has: 16363.6 → 16,364; 12.852 →
  // 12.85; 0.005455 → 0.00546. Two fixed decimals showed the cheapest
  // provider on the market as 0.01, the same figure as one twice its price.
  function sig(v) {
    var n = Number(v);
    if (!isFinite(n)) return '—';
    var a = Math.abs(n);
    if (a >= 1000) return H.fmtInt(Math.round(n));
    if (a >= 100) return n.toFixed(1);
    if (a >= 1) return n.toFixed(2);
    if (a === 0) return '0';
    return n.toPrecision(3).replace(/\.?0+$/, '');
  }
  T._chartSig = sig;
  T._chartFmt = function (unit, v) { return (UNIT_FMT[unit] || H.fmtInt)(v); };

  // Units → the game's own ladders. `rate` is alpha per kW·day; `power` and
  // `mw` are both the chain's milliwatts, which is what fmtWatts takes
  // (2,012,907,666 is the 2.01 MW the market card shows).
  var UNIT_FMT = {
    ore: function (v) { return H.fmtOre(v); },
    alpha: function (v) { return H.fmtAlpha(v); },
    power: function (v) { return H.fmtWatts(v); },
    mw: function (v) { return H.fmtWatts(v); },   // the chain's milliwatts, the ladder fmtWatts already speaks
    rate: function (v) { return sig(v) + '/kW·d'; },
    ratio: function (v) { return sig(v); },
    count: function (v) { return H.fmtInt(v); },
    raw: function (v) { return H.fmtInt(v); },
    pct: function (v) { return Number(v).toFixed(0) + '%'; },
  };
  var UNIT_LABEL = { ore: 'ore', alpha: 'alpha', power: 'watts', mw: 'watts', rate: 'alpha per kW·day', ratio: 'alpha per token', count: 'count', raw: 'value', pct: 'indexed' };

  // ── params ──────────────────────────────────────────────────────────────
  // `series` rides in the params as JSON text: the configure panel can show
  // and edit it, a share code carries it, and a saved chart is exactly it.
  function seriesOf(p) {
    try { var v = JSON.parse(p.series || '[]'); return Array.isArray(v) ? v.filter(function (s) { return s && s.source && s.metric; }) : []; }
    catch (e) { return []; }
  }
  function withSeries(p, list) { return Object.assign({}, p, { series: JSON.stringify(list) }); }
  function keyOf(s) { return s.source + ':' + s.metric + ':' + (s.subject || ''); }

  // The last answer drawn per card: the alert strip offers the series' last
  // value as its starting point, the way a price alert starts at the price.
  var lastData = {};

  /* Alerts rules that name one of this chart's series, as reference lines:
   * `series.stat.ore.2-29604 < 4000` is a dashed line at 4000 on the ore
   * pane, in that series' colour. The rule text is the Alerts card's own. */
  function refsFor(list) {
    var out = [];
    if (!T.parseRules) return out;
    (T.state.layout.cards || []).filter(function (c) { return c.type === 'alerts'; }).forEach(function (c) {
      T.parseRules((c.params || {}).rules).forEach(function (r) {
        if (r.bad || !/^series\./.test(r.metric)) return;
        list.forEach(function (s) {
          if (T.chartRuleFor(s).toLowerCase() === r.metric) out.push({ key: keyOf(s), value: r.value, label: r.text });
        });
      });
    });
    return out;
  }
  T._chartRefsFor = refsFor;

  /* Change over the window: first known reading → last, as a percentage;
   * absolute when the first reading is zero. */
  function delta(values) {
    var first = null, last = null;
    for (var i = 0; i < values.length; i++) { if (values[i] != null && isFinite(values[i])) { first = values[i]; break; } }
    for (var j = values.length - 1; j >= 0; j--) { if (values[j] != null && isFinite(values[j])) { last = values[j]; break; } }
    if (first == null || last == null) return null;
    if (first === 0) return { abs: last - first };
    return { abs: last - first, pct: ((last - first) / Math.abs(first)) * 100 };
  }
  T._chartDelta = delta;

  var catalog = null, catalogAt = 0;
  function loadCatalog() {
    if (catalog && Date.now() - catalogAt < 300000) return Promise.resolve(catalog);
    return invoke('terminal_chart_catalog').then(function (c) { catalog = c; catalogAt = Date.now(); return c; });
  }
  function sourceDef(src) { return ((catalog && catalog.sources) || []).filter(function (s) { return s.source === src; })[0] || null; }

  // The default series for a subject typed at ⌘K: the first metric the
  // catalogue records for that object type — ore for a planet, load for a
  // substation, fuel for a reactor.
  var DEFAULT_METRIC = { planet: 'ore', player: 'ore', struct: 'ore', fleet: 'ore', reactor: 'fuel', substation: 'load', infusion: 'fuel', allocation: 'power', agreement: 'power' };
  function defaultSeriesFor(id) {
    var kind = T.kindOf ? T.kindOf(id) : null;
    var type = { 0: 'guild', 1: 'player', 2: 'planet', 3: 'reactor', 4: 'substation', 5: 'struct', 6: 'allocation', 7: 'infusion', 9: 'fleet', 10: 'provider', 11: 'agreement' }[kind];
    if (!type) return null;
    if (kind === 10) return { source: 'provider', metric: 'rate', subject: id };
    if (kind === 0) return { source: 'bank', metric: 'ratio', subject: id };
    // The catalogue refines the table when it is in hand; the grammar must
    // answer before any chart has asked for it.
    var st = sourceDef('stat');
    var m = st ? st.metrics.filter(function (x) { return (x.object_types || []).indexOf(type) >= 0; })[0] : null;
    var metric = (m && m.metric) || DEFAULT_METRIC[type];
    return metric ? { source: 'stat', metric: metric, subject: id } : null;
  }
  T.defaultChartSeries = defaultSeriesFor;

  // ── indexing ────────────────────────────────────────────────────────────
  // 100 at the first known reading; a series whose first reading is zero
  // cannot be indexed and is drawn as null rather than as infinity.
  function indexed(values) {
    var base = null;
    for (var i = 0; i < values.length; i++) { if (values[i] != null && isFinite(values[i]) && values[i] !== 0) { base = values[i]; break; } }
    if (base == null) return values.map(function () { return null; });
    return values.map(function (v) { return v == null ? null : (v / base) * 100; });
  }
  T._chartIndexed = indexed;

  // ── the library ─────────────────────────────────────────────────────────
  // Built-in charts, each under a ⌘K word of its own. `{player}` `{planet}`
  // `{fleet}` `{guild}` are yours, read from the roster when the chart
  // opens; `providers` is every provider the catalogue knows, up to the six
  // a chart carries. A chart you save under the same word takes the word.
  // Card words always win over these — the grammar asks for a template only
  // after the card words have said no.
  var TEMPLATES = [
    { word: 'RATES',    name: 'Energy market',  window: '604800',  series: [{ source: 'market', metric: 'best' }, { source: 'market', metric: 'median' }, { source: 'market', metric: 'open_capacity_mw' }, { source: 'market', metric: 'offers' }] },
    { word: 'OFFERS',   name: 'Provider rates', window: '604800',  series: 'providers' },
    { word: 'RESERVES', name: 'My ore',         window: '604800',  series: [{ source: 'stat', metric: 'ore', subject: '{player}' }, { source: 'stat', metric: 'ore', subject: '{planet}' }, { source: 'stat', metric: 'ore', subject: '{fleet}' }] },
    { word: 'LOAD',     name: 'My power',       window: '86400',   series: [{ source: 'stat', metric: 'capacity', subject: '{player}' }, { source: 'stat', metric: 'load', subject: '{player}' }, { source: 'stat', metric: 'structs_load', subject: '{player}' }] },
    { word: 'TOKEN',    name: 'My guild token', window: '2592000', series: [{ source: 'bank', metric: 'ratio', subject: '{guild}' }, { source: 'bank', metric: 'collateral', subject: '{guild}' }, { source: 'bank', metric: 'supply', subject: '{guild}' }] },
    { word: 'GALAXY',   name: 'Galaxy energy',  window: '604800',  series: [{ source: 'galaxy', metric: 'capacity', subject: 'substation' }, { source: 'galaxy', metric: 'load', subject: 'substation' }, { source: 'galaxy', metric: 'fuel', subject: 'reactor' }] },
    { word: 'DEPOSITS', name: 'Galaxy ore',     window: '604800',  series: [{ source: 'galaxy', metric: 'ore', subject: 'planet' }, { source: 'galaxy', metric: 'ore', subject: 'player' }, { source: 'galaxy', metric: 'ore', subject: 'fleet' }] },
    { word: 'PULSE',    name: 'Chain pulse',    window: '3600',    series: [{ source: 'chain', metric: 'chain_tx' }, { source: 'chain', metric: 'events' }, { source: 'chain', metric: 'proofs' }] },
    { word: 'COMBAT',   name: 'Combat',         window: '3600',    series: [{ source: 'chain', metric: 'raids' }, { source: 'chain', metric: 'combat' }, { source: 'chain', metric: 'transfers' }] },
  ];
  T.chartTemplates = function () { return TEMPLATES.slice(); };
  T.chartTemplate = function (wordOrName) {
    var key = String(wordOrName || '').trim();
    if (!key) return null;
    return TEMPLATES.filter(function (t) { return t.word === key.toUpperCase(); })[0]
      || TEMPLATES.filter(function (t) { return t.name.toLowerCase() === key.toLowerCase(); })[0]
      || null;
  };
  // The params a template opens with: the series come when the card first
  // draws, so the grammar never waits on the roster.
  T.chartTemplateParams = function (t) { return { template: t.word, name: t.name, window: t.window, series: '[]' }; };

  var rosterMe = null, rosterAt = 0;
  function me() {
    if (rosterMe && Date.now() - rosterAt < 300000) return Promise.resolve(rosterMe);
    return invoke('mcp_roster').then(function (snap) {
      var rows = (snap && snap.rows) || [];
      rosterMe = rows.filter(function (r) { return r.role === 'primary'; })[0] || rows[0] || null;
      rosterAt = Date.now();
      return rosterMe;
    });
  }
  function resolveTemplate(t) {
    if (t.series === 'providers') {
      return loadCatalog().then(function () {
        var def = sourceDef('provider');
        return ((def && def.known) || []).slice(0, MAX_SERIES).map(function (id) { return { source: 'provider', metric: 'rate', subject: id }; });
      });
    }
    var fill = function (m) {
      var map = { '{player}': m && m.player_id, '{planet}': m && m.planet_id, '{fleet}': m && m.fleet_id, '{guild}': m && m.guild_id };
      return t.series.map(function (s) {
        if (!s.subject || !/^\{/.test(s.subject)) return s;
        return map[s.subject] ? Object.assign({}, s, { subject: String(map[s.subject]) }) : null;
      }).filter(Boolean);
    };
    var mine = t.series.some(function (s) { return /^\{/.test(s.subject || ''); });
    return mine ? me().then(fill) : Promise.resolve(fill(null));
  }
  T._chartResolveTemplate = resolveTemplate;

  /* The library as a row of the card's own buttons: what an empty chart
   * offers instead of a sentence about what it could show. */
  function templateRow(p, ctx) {
    var row = H.el('div', 'ch-templates');
    TEMPLATES.forEach(function (t) {
      var a = H.el('a', 'sui-screen-btn sui-mod-secondary', t.name);
      a.href = 'javascript:void(0)';
      a.title = '⌘K ' + t.word;
      a.addEventListener('click', function (ev) { ev.preventDefault(); T.setParams(ctx.id, Object.assign({}, p, T.chartTemplateParams(t))); });
      row.appendChild(a);
    });
    return row;
  }

  // ── the card ────────────────────────────────────────────────────────────
  T.register('chart', {
    label: 'Chart', defaultWidth: 2, cadenceMs: 60000,
    describe: function (p) {
      if (p.name) return String(p.name);
      var list = seriesOf(p);
      if (!list.length) return 'Chart';
      var s = list[0];
      return (s.metric || '').replace(/_/g, ' ') + (s.subject ? ' · ' + s.subject : '') + (list.length > 1 ? ' +' + (list.length - 1) : '');
    },
    params: [
      { key: 'series', label: 'Series (JSON: source, metric, subject)', kind: 'text', placeholder: '[{"source":"market","metric":"best"}]' },
      { key: 'window', label: 'Window', kind: 'choice', options: WINDOWS },
      { key: 'mode', label: 'Draw', kind: 'choice', options: MODES },
      { key: 'scale', label: 'Scale', kind: 'choice', options: SCALES },
      { key: 'index', label: 'Compare', kind: 'choice', options: INDEX },
    ],
    doors: function (card) {
      var p = card.params || {};
      var list = seriesOf(p);
      var doors = [
        { icon: 'icon-copy', title: p.name ? 'Save "' + p.name + '"' : 'Save this chart', onClick: function () { T.chartSaveStrip && T.chartSaveStrip(card.id); } },
        { icon: 'icon-outgoing', title: 'Share this chart', onClick: function () { T.chartShareStrip && T.chartShareStrip(card.id); } },
      ];
      if (list.length) doors.push({ icon: 'icon-alert', title: 'Alert on a series', onClick: function () { T.chartAlertStrip && T.chartAlertStrip(card.id); } });
      var subject = list.map(function (s) { return s.subject; }).filter(function (s) { return s && /^\d+-\d+$/.test(s); })[0];
      if (subject) doors.push({ icon: 'icon-link-out', title: 'Open ' + subject, onClick: function () { T.execute(subject); } });
      return doors;
    },
    render: function (host, p, ctx) {
      var list = seriesOf(p);
      var windowS = Number(p.window || 86400) || 86400;
      var index = String(p.index || '0') === '1';
      var mode = p.mode || 'line', scale = p.scale || 'linear';
      host.innerHTML = '';
      var tpl = p.template && !list.length ? T.chartTemplate(p.template) : null;
      if (tpl) {
        return resolveTemplate(tpl).then(function (series) {
          var next = Object.assign({}, p, { series: JSON.stringify(series) });
          delete next.template;
          if (!series.length) {
            host.appendChild(H.stateBlock('info', tpl.series === 'providers' ? 'no providers on the market yet' : 'no roster yet'));
            return loadCatalog().then(function () { host.appendChild(editor(host, next, ctx)); });
          }
          T.setParams(ctx.id, next);
        }).catch(function (e) {
          host.appendChild(H.stateBlock('error', 'chart unavailable: ' + e));
        });
      }
      return loadCatalog().then(function () {
        if (!list.length) {
          host.appendChild(templateRow(p, ctx));
          host.appendChild(editor(host, p, ctx));
          return;
        }
        return invoke('terminal_chart_series', { series: list.slice(0, MAX_SERIES), windowS: windowS, points: 160 }).then(function (d) {
          /* Zoom to the data there is. An hour of five-minute samples on a
           * seven-day grid is one point per series — "collecting…" on every
           * pane while the ring plainly holds a morning's worth. The window
           * the player chose stays chosen (the strip still says 7d); the
           * plot shows what exists and its caption says since when. */
          var fit = zoomWindow(d, windowS);
          if (fit) {
            return invoke('terminal_chart_series', { series: list.slice(0, MAX_SERIES), windowS: fit, points: 160 }).then(function (d2) {
              lastData[ctx.id] = d2;
              host.innerHTML = '';
              host.appendChild(windowStrip(p, ctx));
              drawPanes(host, p, ctx, d2, { index: index, mode: mode, scale: scale, windowS: fit, since: d2.start_ms });
              host.appendChild(editor(host, p, ctx));
            });
          }
          lastData[ctx.id] = d;
          host.innerHTML = '';
          host.appendChild(windowStrip(p, ctx));
          drawPanes(host, p, ctx, d, { index: index, mode: mode, scale: scale, windowS: windowS });
          host.appendChild(editor(host, p, ctx));
        });
      }).catch(function (e) {
        host.innerHTML = '';
        if (list.length) host.appendChild(windowStrip(p, ctx));
        host.appendChild(H.stateBlock('error', 'chart unavailable: ' + e));
        host.appendChild(editor(host, p, ctx));
      });
    },
  });

  /* The window, as a row of the game's own nav items across the top of the
   * card — the reach for "7d" a trader makes a hundred times a day should
   * not go through the configure panel. */
  function windowStrip(p, ctx) {
    var cur = String(Number(p.window || 86400) || 86400);
    var strip = H.navStrip(WINDOWS.map(function (o) { return { key: o.value, label: o.label.replace(/ hours?$/, 'h').replace(/ days$/, 'd') }; }), cur, function (k) {
      if (k === cur) return;
      T.setParams(ctx.id, Object.assign({}, p, { window: k }));
    });
    strip.classList.add('ch-windows');
    return strip;
  }

  /* The window that fits the data, or null when the chosen one does: when no
   * series has two known points on the grid but some has two samples, the
   * span from the earliest sample to now, with a little room, snapped to at
   * least ten minutes. */
  function zoomWindow(d, windowS) {
    var series = (d && d.series) || [];
    var known = function (s) { return (s.values || []).filter(function (v) { return v != null; }).length; };
    if (series.some(function (s) { return !s.error && known(s) >= 2; })) return null;
    var firsts = series.filter(function (s) { return !s.error && Number(s.samples) >= 2 && s.first_ms; }).map(function (s) { return Number(s.first_ms); });
    if (!firsts.length) return null;
    var span = (d.end_ms || Date.now()) - Math.min.apply(null, firsts);
    var fit = Math.max(600, Math.ceil((span / 1000) * 1.15));
    return fit < windowS * 0.5 ? fit : null;
  }
  T._chartZoomWindow = zoomWindow;

  function clock(ms, windowS) {
    var t = new Date(ms);
    return windowS > 172800
      ? (t.getMonth() + 1) + '/' + t.getDate()
      : ('0' + t.getHours()).slice(-2) + ':' + ('0' + t.getMinutes()).slice(-2);
  }

  /* Panes: group by unit (one pane per unit), or one pane of everything when
   * indexed. Each pane is the shared chart renderer with its own axis. The
   * legend is ours — every series, its colour, its last value, and its ×. */
  function drawPanes(host, p, ctx, d, o) {
    var series = (d.series || []).map(function (s, i) { return Object.assign({ i: i, stroke: STROKES[i % STROKES.length] }, s); });
    var legend = H.el('div', 'ch-legend');
    series.forEach(function (s) {
      var item = H.el('span', 'ch-legend-item' + (s.error ? ' is-err' : ''));
      var key = H.el('span', 'gs-legend-key'); key.style.background = s.stroke; item.appendChild(key);
      item.appendChild(H.el('span', 'fstat-l', s.label || (s.metric + ' ' + (s.subject || ''))));
      var fmt = UNIT_FMT[s.unit] || H.fmtInt;
      item.appendChild(H.el('span', 'ops-val', s.error ? 'unavailable' : (s.last == null ? '—' : fmt(s.last))));
      var dv = s.error ? null : delta(s.values || []);
      if (dv && dv.abs !== 0) {
        var sign = dv.abs > 0 ? '+' : '−';
        var text = dv.pct != null ? sign + Math.abs(dv.pct).toFixed(Math.abs(dv.pct) < 10 ? 1 : 0) + '%' : sign + fmt(Math.abs(dv.abs));
        var dl = H.el('span', 'ch-delta fstat-l' + (dv.abs > 0 ? ' is-up' : ' is-down'), text);
        dl.title = 'over this window: ' + (dv.abs > 0 ? '+' : '−') + fmt(Math.abs(dv.abs));
        item.appendChild(dl);
      }
      if (s.error) item.title = String(s.error);
      var x = H.el('a', 'ch-x', '×'); x.href = 'javascript:void(0)'; x.title = 'Remove this series';
      x.addEventListener('click', function (ev) {
        ev.preventDefault();
        var list = seriesOf(p); list.splice(s.i, 1);
        T.setParams(ctx.id, withSeries(p, list));
      });
      item.appendChild(x);
      legend.appendChild(item);
    });
    host.appendChild(legend);

    var live = series.filter(function (s) { return !s.error && (s.values || []).some(function (v) { return v != null; }); });
    if (!live.length) { host.appendChild(H.stateBlock('info', 'Nothing recorded in this window yet.')); return; }

    var panes = [];
    if (o.index) {
      panes.push({ unit: 'pct', series: live.map(function (s) { return Object.assign({}, s, { values: indexed(s.values) }); }) });
    } else {
      var byUnit = {};
      live.forEach(function (s) { (byUnit[s.unit] = byUnit[s.unit] || []).push(s); });
      Object.keys(byUnit).forEach(function (u) { panes.push({ unit: u, series: byUnit[u] }); });
    }
    var refs = o.index ? [] : refsFor(seriesOf(p));
    var at = function (i) { return d.start_ms + i * d.step_ms; };
    var ticks = [0, 0.5, 1].map(function (f) { return { at: f, text: clock(d.start_ms + f * (d.end_ms - d.start_ms), o.windowS) }; });
    panes.forEach(function (pane) {
      var box = H.el('div', 'gs-line ch-pane');
      var cap = H.el('div', 'gs-cap');
      // One series: its own name says what it is; several: the unit they share.
      cap.appendChild(H.el('span', 'fstat-l', pane.series.length === 1 ? (pane.series[0].label || (UNIT_LABEL[pane.unit] || pane.unit)) : (UNIT_LABEL[pane.unit] || pane.unit)));
      cap.appendChild(H.el('span', 'fstat-l ops-muted', o.mode + (o.scale === 'log' ? ' · log' : '') + (o.since ? ' · since ' + clock(o.since, o.windowS) : '')));
      box.appendChild(cap);
      var fmt = UNIT_FMT[pane.unit] || H.fmtInt;
      var paneRefs = [];
      pane.series.forEach(function (s) {
        refs.filter(function (r) { return r.key === keyOf(s); }).forEach(function (r) { paneRefs.push({ value: r.value, stroke: s.stroke, label: r.label }); });
      });
      if (paneRefs.length) cap.appendChild(H.el('span', 'fstat-l ops-muted ch-refs', paneRefs.map(function (r) { return 'watch ' + fmt(r.value); }).join(' · ')));
      box.appendChild(Board._gamestats.chart({
        series: pane.series.map(function (s) { return { values: s.values, stroke: s.stroke, label: s.label }; }),
        fmt: fmt, zero: pane.unit === 'count', least: pane.unit === 'count' ? 2 : 0, refs: paneRefs,
        mode: o.mode, log: o.scale === 'log', noLegend: true, height: panes.length > 1 ? 56 : 88,
        ticks: ticks, xLabel: function (i) { return clock(at(i), o.windowS); },
      }));
      host.appendChild(box);
    });
  }

  /* The editor: source → metric → subject → Add. Choices come from the
   * catalogue, so what it offers is what Rust will answer. */
  function editor(host, p, ctx) {
    var row = H.el('div', 'ch-editor');
    var sources = (catalog && catalog.sources) || [];
    if (!sources.length) return row;
    var state = { source: sources[0].source, metric: sources[0].metrics[0] && sources[0].metrics[0].metric, subject: '' };
    var metricSel, subjectBox, subjectSel;
    var paint = function () {
      row.innerHTML = '';
      var def = sourceDef(state.source) || sources[0];
      var srcSel = H.selectBox(state.source, sources.map(function (s) { return { value: s.source, label: s.label }; }), function (v) {
        state.source = v; var d2 = sourceDef(v); state.metric = d2 && d2.metrics[0] ? d2.metrics[0].metric : ''; state.subject = ''; paint();
      });
      row.appendChild(H.field('Series', srcSel));
      metricSel = H.selectBox(state.metric, def.metrics.map(function (m) { return { value: m.metric, label: (m.label || m.metric).replace(/_/g, ' ') }; }), function (v) { state.metric = v; if (def.subject === 'object_type') paint(); });
      row.appendChild(H.field('Metric', metricSel));
      if (def.subject === 'object_type') {
        var m = def.metrics.filter(function (x) { return x.metric === state.metric; })[0];
        var types = (m && m.object_types) || OBJECT_TYPES;
        if (types.indexOf(state.subject) < 0) state.subject = types[0];
        subjectSel = H.selectBox(state.subject, types.map(function (t) { return { value: t, label: 'every ' + t }; }), function (v) { state.subject = v; });
        row.appendChild(H.field('Of', subjectSel));
      } else if (def.subject) {
        var known = def.known || [];
        if (known.length && def.source === 'provider') {
          if (known.indexOf(state.subject) < 0) state.subject = known[0];
          subjectSel = H.selectBox(state.subject, known.map(function (id) { return { value: id, label: id }; }), function (v) { state.subject = v; });
          row.appendChild(H.field('Provider', subjectSel));
        } else {
          subjectBox = H.textBox(state.subject, def.subject === 'guild' ? '0-1' : '2-29604', function (v) { state.subject = v; });
          row.appendChild(H.field(def.subject === 'guild' ? 'Guild' : 'Object', subjectBox));
        }
      }
      var addBtn = H.el('a', 'sui-screen-btn sui-mod-primary', 'Add');
      addBtn.href = 'javascript:void(0)';
      addBtn.addEventListener('click', function (ev) {
        ev.preventDefault();
        var list = seriesOf(p);
        if (list.length >= MAX_SERIES) { Board.stamp && Board.stamp('six series is the most one chart can carry'); return; }
        var s = { source: state.source, metric: state.metric };
        if (def.subject) {
          var subj = String(state.subject || '').trim();
          if (!subj) { Board.stamp && Board.stamp('this series needs a subject'); return; }
          s.subject = subj;
        }
        if (list.some(function (x) { return keyOf(x) === keyOf(s); })) { Board.stamp && Board.stamp('that series is already on the chart'); return; }
        list.push(s);
        T.setParams(ctx.id, withSeries(p, list));
      });
      row.appendChild(addBtn);
    };
    paint();
    return row;
  }

  // ── strips: save · share · alert ────────────────────────────────────────
  // Each is a row that appears under the card body once, from its door, and
  // goes away when done. The card's own params are what gets saved.
  function stripHost(cardId) {
    var node = document.querySelector('#tm-' + cardId + ' .tm-body');
    if (!node) return null;
    var old = node.querySelector('.ch-strip');
    if (old) { old.parentNode.removeChild(old); return null; }
    var strip = H.el('div', 'ch-strip');
    node.appendChild(strip);
    // The body scrolls past a tall chart; a strip that opens below the fold
    // is a door that seems to do nothing.
    if (strip.scrollIntoView) { try { strip.scrollIntoView({ block: 'nearest' }); } catch (e) { strip.scrollIntoView(false); } }
    return strip;
  }
  function cardParams(cardId) {
    var c = (T.state.layout.cards || []).filter(function (x) { return x.id === cardId; })[0];
    return c ? (c.params || {}) : null;
  }

  T.chartSaveStrip = function (cardId) {
    var strip = stripHost(cardId); if (!strip) return;
    var p = cardParams(cardId) || {};
    var name = H.textBox(p.name || '', 'Name this chart', function () {});
    var word = H.textBox(p.word || '', '⌘K word (optional)', function () {});
    strip.appendChild(H.field('Name', name));
    strip.appendChild(H.field('Word', word));
    var go = H.el('a', 'sui-screen-btn sui-mod-primary', 'Save'); go.href = 'javascript:void(0)';
    go.addEventListener('click', function (ev) {
      ev.preventDefault();
      var params = Object.assign({}, p, { name: name.value.trim(), word: word.value.trim().toUpperCase() || undefined });
      delete params.word; // the word lives beside the chart in Rust, not in the card
      invoke('terminal_chart_save', { name: name.value.trim(), params: params, word: word.value.trim() || null }).then(function (r) {
        T.charts = r.charts || T.charts;
        T.setParams(cardId, Object.assign({}, p, { name: r.name, word: r.word || undefined }));
        Board.stamp && Board.stamp('saved "' + r.name + '"' + (r.word ? ' · ⌘K ' + r.word : ''));
      }).catch(function (e) { go.classList.add('is-err'); Board.stamp && Board.stamp('save: ' + e); });
    });
    strip.appendChild(go);
    name.focus();
  };

  T.exportChart = function (p) {
    var payload = { chart: { name: p.name || '', word: p.word || '', params: { series: p.series || '[]', window: p.window, mode: p.mode, scale: p.scale, index: p.index, name: p.name } } };
    return 'terminal:' + btoa(unescape(encodeURIComponent(JSON.stringify(payload))));
  };
  T.chartShareStrip = function (cardId) {
    var strip = stripHost(cardId); if (!strip) return;
    var p = cardParams(cardId) || {};
    var code = H.textBox(T.exportChart(p), '', function () {}); code.readOnly = true;
    code.addEventListener('focus', function () { code.select(); });
    strip.appendChild(code);
    var copy = H.el('a', 'sui-screen-btn sui-mod-secondary', 'Copy'); copy.href = 'javascript:void(0)';
    copy.addEventListener('click', function () {
      var done = function () { copy.textContent = 'Copied'; };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(code.value).then(done, function () { code.select(); });
      else { code.select(); done(); }
    });
    strip.appendChild(copy);
    var send = H.el('a', 'sui-screen-btn sui-mod-primary', 'Send to Comms'); send.href = 'javascript:void(0)';
    send.addEventListener('click', function () {
      invoke('matrix_open', { subject: null, draft: 'Chart' + (p.name ? ' "' + p.name + '"' : '') + ' — paste into the Terminal: IMPORT ' + code.value })
        .then(function () { send.textContent = 'Sent'; }).catch(function (e) { Board.stamp && Board.stamp('needs Comms: ' + e); });
    });
    strip.appendChild(send);
  };

  /* An alert is a watchlist rule on the series' latest value:
   * `series.<source>.<metric>[.<subject>] < 2`. The rule text is the same
   * one the Alerts card takes, so a chart can hand it over. */
  T.chartRuleFor = function (s) { return 'series.' + s.source + '.' + s.metric + (s.subject ? '.' + s.subject : ''); };
  T.chartAlertStrip = function (cardId) {
    var strip = stripHost(cardId); if (!strip) return;
    var p = cardParams(cardId) || {}, list = seriesOf(p);
    if (!list.length) return;
    var d = lastData[cardId];
    var lastOf = function (key) {
      var sr = d && (d.series || []).filter(function (x) { return keyOf(x) === key; })[0];
      if (!sr || sr.error || sr.last == null) return '';
      var n = Number(sr.last);
      return isFinite(n) ? String(Math.abs(n) >= 100 ? Math.round(n) : Number(n.toFixed(3))) : '';
    };
    var val = H.textBox(lastOf(keyOf(list[0])), 'value', function () {});
    var which = H.selectBox(keyOf(list[0]), list.map(function (s) { return { value: keyOf(s), label: (s.metric + ' ' + (s.subject || s.source)).replace(/_/g, ' ') }; }), function (k) { val.value = lastOf(k); });
    var op = H.selectBox('<', [{ value: '<', label: 'below' }, { value: '>', label: 'above' }], function () {});
    strip.appendChild(H.field('When', which)); strip.appendChild(H.field('is', op)); strip.appendChild(H.field('', val));
    var go = H.el('a', 'sui-screen-btn sui-mod-primary', 'Watch'); go.href = 'javascript:void(0)';
    go.addEventListener('click', function (ev) {
      ev.preventDefault();
      var s = list.filter(function (x) { return keyOf(x) === which.value; })[0];
      var n = Number(val.value);
      if (!s || !isFinite(n)) { val.classList.add('is-err'); return; }
      var rule = T.chartRuleFor(s) + ' ' + op.value + ' ' + n;
      // One Alerts card per window: append to it, or make it.
      var alerts = (T.state.layout.cards || []).filter(function (c) { return c.type === 'alerts'; })[0];
      if (alerts) {
        var rules = String((alerts.params || {}).rules || '').trim();
        T.setParams(alerts.id, Object.assign({}, alerts.params || {}, { rules: rules ? rules + '\n' + rule : rule }));
      } else {
        T.add('alerts', { rules: rule }, 1);
      }
      Board.stamp && Board.stamp('watching ' + rule);
      var host = strip.parentNode; if (host) host.removeChild(strip);
    });
    strip.appendChild(go);
  };

  /* The reading an Alerts rule gets for `series.<source>.<metric>[.<subject>]`:
   * the latest value in the last six hours. */
  var readingUnits = {};
  var UNIT_ICON = { ore: 'sui-icon-alpha-ore', alpha: 'sui-icon-alpha-matter', rate: 'sui-icon-alpha-matter', ratio: 'sui-icon-alpha-matter', power: 'sui-icon-energy', mw: 'sui-icon-energy' };
  T.chartReading = function (metric) {
    var m = /^series\.([a-z]+)\.([a-z_]+)(?:\.(.+))?$/i.exec(String(metric || ''));
    if (!m) return null;
    var s = { source: m[1].toLowerCase(), metric: m[2].toLowerCase() };
    if (m[3]) s.subject = m[3];
    return function () {
      return invoke('terminal_chart_series', { series: [s], windowS: 21600, points: 8 }).then(function (d) {
        var sr = d && d.series && d.series[0];
        if (!sr || sr.error) return null;
        if (sr.unit) readingUnits[String(metric).toLowerCase()] = sr.unit;
        return sr.last == null ? null : Number(sr.last);
      });
    };
  };
  // The Alerts card shows a series reading in the series' own unit — ore as
  // kilograms, a rate per kW·day — and with the icon that unit carries.
  T.chartValueFmt = function (metric) { var u = readingUnits[String(metric || '').toLowerCase()]; return u ? (UNIT_FMT[u] || null) : null; };
  T.chartValueIcon = function (metric) { var u = readingUnits[String(metric || '').toLowerCase()]; return (u && UNIT_ICON[u]) || null; };
})();
