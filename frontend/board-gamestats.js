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

  // ── Sparkline ─────────────────────────────────────────────────────────────
  // SUI has no graph component, so this is the one hand-rolled visual: a
  // single-path inline SVG. Colors are semantic tokens only.
  var SVG_NS = 'http://www.w3.org/2000/svg';
  function sparkline(values, strokeVar) {
    var w = 900, h = 56;
    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.style.cssText = 'display:block;width:100%;height:' + h + 'px;';
    function collecting() {
      var t = document.createElementNS(SVG_NS, 'text');
      t.setAttribute('x', '4'); t.setAttribute('y', String(h - 6));
      t.setAttribute('fill', 'var(--text-hint)');
      // 8, not 10: SUI's type roles are 8/12/16 and this is a hint label,
      // which is the 8px role. 10 rendered a pixel face at 1.25x.
      t.setAttribute('font-size', '8');
      t.textContent = 'collecting…';
      svg.appendChild(t);
      return svg;
    }
    var nums = values.filter(function (v) { return typeof v === 'number' && isFinite(v); });
    if (nums.length < 2) return collecting();
    var min = Math.min.apply(null, nums), max = Math.max.apply(null, nums);
    var span = (max - min) || 1;
    var step = values.length > 1 ? w / (values.length - 1) : w;
    /* Gaps BREAK the line; they are not drawn through and not drawn as zero.
     *
     * A gap means "no sample", and both alternatives assert something false:
     * a zero invents a crash, and a straight line across invents readings
     * nobody took. Starting a fresh `M` after a gap leaves a visible break,
     * which is the honest shape.
     *
     * It also keeps NaN out of the path. `d` is one attribute — a single
     * non-finite value anywhere in it invalidates the whole path and the
     * chart silently renders nothing.
     */
    var d = '';
    var pen = 'M';
    var drew = false;
    values.forEach(function (v, i) {
      if (typeof v !== 'number' || !isFinite(v)) { pen = 'M'; return; }
      var y = h - 3 - ((v - min) / span) * (h - 6);
      d += pen + (i * step).toFixed(1) + ' ' + y.toFixed(1);
      if (pen === 'L') drew = true;
      pen = 'L';
    });
    /* Two samples are not two samples if a gap sits between them.
     *
     * `nums.length >= 2` was the test for "there is a line to draw", and it is
     * not: `[5, null, 7]` passes it and produces two lone movetos, which SVG
     * draws as nothing at all. An empty chart with no caption reads as broken.
     * Ask the real question — did any segment get drawn — instead of a proxy
     * for it.
     */
    if (!drew) return collecting();
    var base = document.createElementNS(SVG_NS, 'line');
    base.setAttribute('x1', '0'); base.setAttribute('x2', String(w));
    base.setAttribute('y1', String(h - 1)); base.setAttribute('y2', String(h - 1));
    base.setAttribute('stroke', 'var(--border-subtle)');
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

  var TRENDS = [
    { key: 'events', label: 'events / block', stroke: 'var(--text-player-primary)' },
    { key: 'combat', label: 'combat / block', stroke: 'var(--text-enemy-primary)' },
    { key: 'tx', label: 'transactions / block', stroke: 'var(--accent-primary)' },
    { key: 'raids', label: 'live raids', stroke: 'var(--text-warning)' },
    // Steps between heavy sweeps rather than moving per block — still the
    // right place to see the galaxy powering up over an hour.
    { key: 'draw', label: 'structs draw', stroke: 'var(--accent-secondary)', fmt: function (v) { return H.fmtWatts(v); } },
  ];
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
      var line = H.el('div');
      line.style.marginBottom = '8px';
      var cap = H.el('div');
      cap.style.cssText = 'display:flex;justify-content:space-between;align-items:baseline;';
      cap.appendChild(H.el('span', 'sui-text-hint', t.label));
      cap.appendChild(H.el('span', 'ops-val', (t.fmt || H.fmtNum)(vals[vals.length - 1])));
      line.appendChild(cap);
      line.appendChild(sparkline(vals, t.stroke));
      body.appendChild(line);
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
      host.appendChild(universeCard(state.snap.totals || {}));

      // Trends stretch the full row — the sparklines are the best thing on
      // the page and cramped in a half column. They also sit above the
      // leaderboards so the scroll path never threads through the boards'
      // inner scrollbars.
      host.appendChild(trendsCard());

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
    var tiles = host.querySelectorAll('.fstat');
    // The Block tile is always first in the strip.
    if (tiles.length) {
      var v = tiles[0].querySelector('.fstat-v');
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
  Board._gamestats = { sparkline: sparkline, seriesValues: seriesValues, state: state };

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
