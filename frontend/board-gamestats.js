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
    metric: { key: 'structs_load', dir: -1 }, // sortControl contract
    renderTimer: null,
    lastRender: 0,
  };

  var SERIES_CAP = 720; // mirror of the Rust ring

  // Structs load first and default: it is the one metric the whole galaxy
  // competes on (top ranks trade places between guilds). The live alpha
  // distribution is one whale and a flat tail, and stored ore is a handful
  // of grams — real but dull as a first impression.
  var METRICS = [
    { key: 'structs_load', label: 'structs load', icon: 'sui-icon-deployed-structs', fmt: function (v) { return H.fmtWatts(v); } },
    { key: 'ore', label: 'ore', icon: 'sui-icon-alpha-ore', fmt: function (v) { return H.fmtOre(v); } },
    { key: 'alpha', label: 'alpha', icon: 'sui-icon-alpha-matter', fmt: function (v) { return H.fmtAlpha(v); } },
  ];
  function metricDef(key) {
    for (var i = 0; i < METRICS.length; i++) if (METRICS[i].key === key) return METRICS[i];
    return METRICS[0];
  }

  // ── Sparkline ─────────────────────────────────────────────────────────────
  // SUI has no graph component, so this is the one hand-rolled visual: a
  // single-path inline SVG. Colors are semantic tokens only.
  var SVG_NS = 'http://www.w3.org/2000/svg';
  function sparkline(values, strokeVar) {
    var w = 600, h = 44;
    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.style.cssText = 'display:block;width:100%;height:' + h + 'px;';
    var nums = values.filter(function (v) { return typeof v === 'number' && isFinite(v); });
    if (nums.length < 2) {
      var t = document.createElementNS(SVG_NS, 'text');
      t.setAttribute('x', '4'); t.setAttribute('y', String(h - 6));
      t.setAttribute('fill', 'var(--text-hint)');
      t.setAttribute('font-size', '10');
      t.textContent = 'collecting…';
      svg.appendChild(t);
      return svg;
    }
    var min = Math.min.apply(null, nums), max = Math.max.apply(null, nums);
    var span = (max - min) || 1;
    var step = values.length > 1 ? w / (values.length - 1) : w;
    var d = '';
    values.forEach(function (v, i) {
      var y = h - 3 - ((v - min) / span) * (h - 6);
      d += (d ? 'L' : 'M') + (i * step).toFixed(1) + ' ' + y.toFixed(1);
    });
    var base = document.createElementNS(SVG_NS, 'line');
    base.setAttribute('x1', '0'); base.setAttribute('x2', String(w));
    base.setAttribute('y1', String(h - 1)); base.setAttribute('y2', String(h - 1));
    base.setAttribute('stroke', 'var(--border-primary, var(--text-hint))');
    base.setAttribute('stroke-width', '0.5');
    svg.appendChild(base);
    var path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', strokeVar || 'var(--text-player-primary)');
    path.setAttribute('stroke-width', '1.5');
    path.setAttribute('vector-effect', 'non-scaling-stroke');
    svg.appendChild(path);
    return svg;
  }

  function seriesValues(key) {
    var s = (state.snap && state.snap.series) || [];
    return s.map(function (p) { return Number(p[key]) || 0; });
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
    strip.appendChild(H.statTile(['Active', 'last 24h'], H.fmtInt(num(t.active_24h)), null, 'ok'));
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
    c.style.marginBottom = '10px';
    return c;
  }

  function pfpNode(row) {
    var attrs = row.pfp_attrs;
    if (attrs && typeof attrs !== 'string') attrs = JSON.stringify(attrs);
    return H.pfpPortrait(attrs);
  }

  function playersCard() {
    var body = H.el('div');
    var def = metricDef(state.metric.key);
    var toolbar = H.el('div');
    toolbar.style.cssText = 'display:flex;justify-content:flex-end;margin-bottom:6px;';
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
        table.appendChild(H.resultRow({
          portrait: pfpNode(r),
          title: '#' + r.rank + '  ' + (r.username || r.player_id),
          subtitle: (r.guild_name || '') + (r.tag ? ' [' + r.tag + ']' : ''),
          chips: [H.statTile(def.label, def.fmt(num(r.value)), def.icon)],
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
      var table = H.resultTable();
      rows.forEach(function (g, i) {
        var e = energyByGuild[g.guild_id];
        table.appendChild(H.resultRow({
          icon: 'sui-icon-players',
          title: '#' + (i + 1) + '  ' + (g.name || g.guild_id),
          subtitle: g.guild_id,
          chips: [
            H.statTile('Members', H.fmtInt(num(g.members))),
            H.statTile('Alpha', H.fmtAlpha(num(g.alpha)), 'sui-icon-alpha-matter'),
            H.statTile('Capacity', e ? H.fmtWatts(num(e.capacity)) : '—', 'sui-icon-energy'),
            H.statTile('Planets', H.fmtInt(num(g.planets_complete))),
          ],
        }));
      });
      body.appendChild(table);
    }
    return H.card('BEST GUILDS', body);
  }

  var TRENDS = [
    { key: 'events', label: 'events / block', stroke: 'var(--text-player-primary)' },
    { key: 'combat', label: 'combat / block', stroke: 'var(--text-enemy-primary)' },
    { key: 'tx', label: 'transactions / block', stroke: 'var(--accent-primary)' },
    { key: 'raids', label: 'live raids', stroke: 'var(--text-warning)' },
    // Steps between heavy sweeps rather than moving per block — still the
    // right place to see the galaxy powering up over an hour.
    { key: 'draw', label: 'structs draw', stroke: 'var(--accent-secondary)', fmt: function (v) { return H.fmtWatts(v); } },
  ];
  function trendsCard() {
    var body = H.el('div', null);
    body.id = 'gs-trends';
    buildTrends(body);
    return H.card('TRENDS — LAST HOUR OF BLOCKS', body);
  }
  function buildTrends(body) {
    body.innerHTML = '';
    TRENDS.forEach(function (t) {
      var vals = seriesValues(t.key);
      var line = H.el('div');
      line.style.marginBottom = '8px';
      var cap = H.el('div');
      cap.style.cssText = 'display:flex;justify-content:space-between;align-items:baseline;';
      cap.appendChild(H.el('span', 'sui-text-hint', t.label));
      cap.appendChild(H.el('span', 'ops-val',
        vals.length ? (t.fmt || H.fmtNum)(vals[vals.length - 1]) : '—'));
      line.appendChild(cap);
      line.appendChild(sparkline(vals, t.stroke));
      body.appendChild(line);
    });
  }

  // Energy production vs draw, from the grid rollup (raw milliwatts). One
  // tile row for the galaxy, then a utilization bar per guild.
  function energyCard() {
    var body = H.el('div');
    var t = state.snap.totals || {};
    var draw = num(t.structs_draw), alloc = num(t.alloc_load), cap = num(t.player_capacity);

    // Vocabulary matters here: player-level grid `load` is power a hub player
    // routes ONWARD (to substations), so adding it to structs draw and calling
    // the sum "demand" double-counts the re-export leg — the live numbers made
    // that plain (draw 10.8MW + routed 23.6MW vs 28.5MW delivered).
    var strip = H.el('div', 'hstrip');
    strip.style.marginBottom = '10px';
    strip.appendChild(H.statTile(['Structs Draw', 'deployed structs'],
      H.fmtWatts(draw), 'sui-icon-deployed-structs'));
    strip.appendChild(H.statTile(['Routed Onward', 'hub allocations'], H.fmtWatts(alloc)));
    strip.appendChild(H.statTile(['Delivered', 'direct-fed capacity'],
      H.fmtWatts(cap), 'sui-icon-energy'));
    var util = cap > 0 && draw != null ? draw / cap : null;
    strip.appendChild(H.statTile(['Structs Share', 'of delivered power'],
      util == null ? '—' : Math.round(util * 100) + '%', null,
      util == null ? 'muted' : (util > 0.9 ? 'live' : 'ok')));
    body.appendChild(strip);

    // Guilds ranked by draw, bar relative to the leader. Capacity concentrates
    // in a handful of hub players, so most guilds honestly have none — the
    // figure is appended only where it exists.
    var rows = state.snap.guild_energy || [];
    if (!rows.length) {
      body.appendChild(H.stateBlock('info', 'Loading…'));
    } else {
      var top = num(rows[0].structs_draw) || 1;
      rows.forEach(function (g) {
        var gDraw = num(g.structs_draw) || 0;
        var gCap = num(g.capacity) || 0;
        var line = H.el('div');
        line.style.cssText = 'display:grid;grid-template-columns:minmax(150px,1fr) minmax(60px,120px) auto;gap:8px;align-items:center;padding:2px 0;';
        var name = H.el('span', 'sui-text-hint', g.name || g.guild_id);
        name.style.textAlign = 'left';
        line.appendChild(name);
        line.appendChild(H.progressBar(gDraw / top));
        var val = H.el('span', 'ops-val');
        val.style.cssText = 'text-align:right;white-space:nowrap;';
        // draw · delivered — the tile captions above define the vocabulary,
        // so the row doesn't repeat the word and wrap itself onto three lines.
        val.textContent = H.fmtWatts(gDraw) + (gCap > 0 ? ' · ' + H.fmtWatts(gCap) : '');
        line.appendChild(val);
        body.appendChild(line);
      });
    }
    return H.card('ENERGY GRID', body);
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
      host.appendChild(universeCard(state.snap.totals || {}));

      var cols = H.el('div');
      cols.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fit,minmax(420px,1fr));gap:10px;align-items:start;';
      // Trends/census first: the leaderboards own inner scrollbars, and a
      // mouse-wheel path down the page gets captured by them — the fixed-height
      // cards go above so everything is reachable without threading past a
      // scroll trap.
      cols.appendChild(trendsCard());
      cols.appendChild(energyCard());
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
    var tiles = host.querySelectorAll('.fstat');
    // The Block tile is always first in the strip.
    if (tiles.length) {
      var v = tiles[0].querySelector('.fstat-v');
      if (v) v.textContent = H.fmtInt(state.snap.block_height);
    }
  }

  function pull() {
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
    Board.T.event.listen('game-stats-update', function (e) {
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
      if (p.tier === 'fast' || p.tier === 'heavy') {
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
    Board.T.event.listen('grass-event', function (e) {
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
