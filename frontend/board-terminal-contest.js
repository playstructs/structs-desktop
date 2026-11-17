// STRUCTS TERMINAL — Sector Blitz (influence contests), eight read-only cards.
//
//   CONTEST [#]                 status, clock, rules, who controls each sector
//   STANDINGS [sector]          guilds × sectors, and the path to each lead
//   RACE [sector]               points over block height, pace to the end
//   TERRITORY <sector>          every planet of a sector: claims, coverage, worth
//   IP <guild|player|planet>    one object's influence dossier
//   LEADERS [guilds|players] [sector]
//   HUNT [sector]               raid targets ranked by what a win is worth to us
//   CLAIMS [sector]             who scored, block by block, and lead changes
//
// READ ONLY. Every number comes from the guild's `/api/influence` routes and
// its raid search through mcp/influence.rs; nothing here signs anything. The
// doors open things — a player, a guild, a planet on the map, another card.
//
// Scores are exact decimal strings in the API; they are small enough to do
// arithmetic on as Numbers and are printed with H.fmtInt. Personal points are
// NOT shares of guild points (two members can win the same planet; the guild
// is credited once), so nothing here adds members up to a guild total except
// the repeat-win count, which exists to show exactly that gap.
//
// Loaded after board-terminal.js; registers into Board.Terminal.
(function () {
  'use strict';
  var Board = window.Board, T = Board.Terminal, H = Board.helpers;
  var invoke = function (cmd, args) { return Board.T.core.invoke(cmd, args || {}); };
  var add = function (type, params, w) { return T.add(type, params, w); };

  // ── The contest's fixed vocabulary (webapp SectorBlitzConstants.js) ──
  var SECTORS = [
    { id: 44, label: 'Sector 044', light: 'teal' },
    { id: 127, label: 'Sector 127', light: 'yellow' },
    { id: 999, label: 'Sector 999', light: 'purple' },
  ];
  /* TaskConstants.ESTIMATED_BLOCK_TIME, the webapp's own clock estimate. */
  var BLOCK_MS = 6000;
  /* The webapp colours guilds by overall position: 1st, 2nd, 3rd, everyone
   * else (SECTOR_BLITZ_GUILD_COLOURS). The race draws more lines than three,
   * so it continues the list with other SUI accents. */
  var RANK_CLS = ['ipc-c0', 'ipc-c1', 'ipc-c2'];
  var OTHER_CLS = 'ipc-cx';
  var SERIES_CLS = ['ipc-c0', 'ipc-c1', 'ipc-c2', 'ipc-c3', 'ipc-c4', 'ipc-c5'];
  var STATUS = {
    active: ['Live', 'default'], scheduled: ['Scheduled', 'warning'], awaiting_sectors: ['Awaiting sectors', 'warning'],
    final: ['Final', 'solid'], unavailable: ['No scores', 'destructive'],
  };
  var SECTOR_OPTS = [{ value: '', label: 'All sectors' }].concat(SECTORS.map(function (s) { return { value: String(s.id), label: s.label }; }));
  var SCORING_OPTS = SECTORS.map(function (s) { return { value: String(s.id), label: s.label }; });
  var IP_ICON = 'sector-blitz-influence-icon';

  // ── Pure pieces (T.contest, for the harness) ──
  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
  function fmt(v) { return H.fmtInt(num(v)); }
  function signed(n) { return (n > 0 ? '+' : n < 0 ? '−' : '') + H.fmtInt(Math.abs(n)); }
  function sectorOf(id) { id = Number(id); for (var i = 0; i < SECTORS.length; i++) if (SECTORS[i].id === id) return SECTORS[i]; return null; }
  function sectorLabel(id, mode) {
    if (mode === 'single_sector') return 'All planets';
    if (Number(id) === 0) return 'Unassigned';
    var s = sectorOf(id);
    return s ? s.label : 'Sector ' + id;
  }
  /* The sectors a contest scores: 0 is "unassigned" in a planet-sector
   * contest and the only sector of a single-sector one. */
  function scoringSectors(c) {
    if (c && c.scoring_mode === 'single_sector') return [0];
    return SECTORS.map(function (s) { return s.id; });
  }
  /* The guild API's error, as the sentence it sent: `Guild API 503 <url>:
   * Contest has no complete published scoring snapshot` → the sentence. */
  function errText(e) {
    var s = String(e && e.message ? e.message : e).replace(/^Error:\s*/, '');
    var m = /Guild API (\d{3}) \S+: ([\s\S]+)$/.exec(s);
    return m ? m[2] : s;
  }
  /* Which contest a card shows when none is named: the live one (newest
   * start), else one waiting on sectors, else the newest final, else the next
   * scheduled. Named, it is that contest or nothing. */
  function pickContest(list, want) {
    list = list || [];
    if (want != null && want !== '') {
      return list.filter(function (c) { return String(c.contest_id) === String(want); })[0] || null;
    }
    var by = function (status) { return list.filter(function (c) { return c.status === status; }); };
    var newest = function (rows, key) { return rows.slice().sort(function (a, b) { return num(b[key]) - num(a[key]); })[0] || null; };
    return newest(by('active'), 'start_height') || newest(by('awaiting_sectors'), 'end_height')
      || newest(by('final'), 'end_height')
      || by('scheduled').slice().sort(function (a, b) { return num(a.start_height) - num(b.start_height); })[0]
      || newest(list, 'contest_id');
  }
  /* The standings scoreboard folded into one row per guild and the leader
   * set of each sector. Ties share the lead; zero never leads. */
  function matrix(rows, sectors) {
    var byGuild = {}, order = [], top = {}, leaders = {};
    sectors.forEach(function (s) { top[s] = 0; leaders[s] = []; });
    (rows || []).forEach(function (r) {
      var g = r.guild_id, s = Number(r.sector);
      if (!byGuild[g]) { byGuild[g] = { guild_id: g, overall: num(r.overall_points), cells: {}, held: 0 }; order.push(g); }
      byGuild[g].cells[s] = { points: num(r.points), unique: num(r.unique_planets), held: num(r.held_planets),
        rank: num(r.sector_rank), tied: !!r.tied_for_lead, winner: !!r.is_winner };
      byGuild[g].held += num(r.held_planets);
      if (s in top && num(r.points) > top[s]) top[s] = num(r.points);
    });
    order.forEach(function (g) {
      sectors.forEach(function (s) {
        var c = byGuild[g].cells[s];
        if (c && c.points > 0 && c.points === top[s]) leaders[s].push(g);
      });
    });
    var guilds = order.map(function (g) { return byGuild[g]; }).sort(function (a, b) { return b.overall - a.overall || (a.guild_id < b.guild_id ? -1 : 1); });
    return { guilds: guilds, top: top, leaders: leaders, byGuild: byGuild };
  }
  /* What it takes to reach a sector's lead from `gap` points behind. A unique
   * win is +win; taking a claim the leader holds is +claim to you and −claim
   * to them. Exact ties share the lead, so a gap that divides evenly can be
   * TIED in gap/win wins. */
  function pathToLead(gap, win, claim, leaderHeld) {
    win = num(win); claim = num(claim);
    if (gap <= 0 || win <= 0) return { tie: null, pass: 0, flips: 0, flipsPossible: true };
    var flips = claim > 0 ? Math.ceil((gap + 1) / (2 * claim)) : null;
    return {
      tie: gap % win === 0 ? gap / win : null,
      pass: Math.floor(gap / win) + 1,
      flips: flips,
      flipsPossible: flips != null && (leaderHeld == null || flips <= leaderHeld),
    };
  }
  /* What a successful raid on this planet is worth to `guild` right now
   * (influence-api.md, "Planet lookups"): the unique bonus unless the guild
   * is already credited, the claim unless it already holds it. A raid on
   * your own guild's planet scores nothing. */
  function worthFor(planet, guild, win, claim, ownerGuild) {
    if (!guild) return null;
    if (ownerGuild && ownerGuild === guild) return { unique: 0, claim: 0, total: 0, own: true };
    var cov = (planet && planet.guild_coverage) || [];
    var covered = cov.some(function (c) { return c.guild_id === guild; });
    var holds = !!planet && planet.holder_guild_id === guild;
    var u = covered ? 0 : num(win), c = holds ? 0 : num(claim);
    return { unique: u, claim: c, total: u + c, own: false, covered: covered, holds: holds };
  }
  /* Members' unique wins add up to more than the guild's when two members
   * win the same planet. The difference is wins the guild did not need. */
  function repeatWins(guildUnique, members) {
    var sum = (members || []).reduce(function (a, m) { return a + num(m.unique_planets); }, 0);
    var extra = Math.max(0, sum - num(guildUnique));
    return { member_wins: sum, repeat: extra, share: sum > 0 ? extra / sum : 0 };
  }
  /* A bucket size that keeps a range to about `samples` points, in whole
   * hundreds of blocks (the API caps one series at 1,000). */
  function bucketFor(range, samples) {
    var b = Math.ceil(Math.max(1, range) / Math.max(1, samples || 120) / 100) * 100;
    return Math.max(100, Math.min(1000000, b));
  }
  /* History → one series per key: [{h, v}] starting at the opening balance
   * (the block before the range), then each bucket's closing balance. */
  function seriesOf(hist, keyOf, startHeight) {
    var out = {};
    var get = function (k) { return out[k] || (out[k] = []); };
    ((hist && hist.opening) || []).forEach(function (r) { get(keyOf(r)).push({ h: num(startHeight) - 1, v: num(r.points) }); });
    ((hist && hist.samples) || []).forEach(function (r) {
      get(keyOf(r)).push({ h: num(r.height), v: num(r.points), d: num(r.points_delta), du: num(r.unique_delta), dc: num(r.claim_delta), from: num(r.start_height) });
    });
    Object.keys(out).forEach(function (k) { out[k].sort(function (a, b) { return a.h - b.h; }); });
    return out;
  }
  /* Points per 1,000 blocks over the last `span0` blocks of a series. */
  function paceOf(pts, span0) {
    if (!pts || pts.length < 2) return 0;
    var last = pts[pts.length - 1], from = last.h - span0, base = pts[0];
    for (var i = pts.length - 1; i >= 0; i--) { if (pts[i].h <= from) { base = pts[i]; break; } }
    var span = last.h - base.h;
    return span > 0 ? (last.v - base.v) * 1000 / span : 0;
  }
  /* Who led at each height, and the heights where that changed. Ties are
   * shared leads: a change is a different SET of leaders. */
  function leadTimeline(series, keys) {
    var heights = {};
    keys.forEach(function (k) { (series[k] || []).forEach(function (p) { heights[p.h] = 1; }); });
    var hs = Object.keys(heights).map(Number).sort(function (a, b) { return a - b; });
    var at = function (k, h) { var v = 0, s = series[k] || []; for (var i = 0; i < s.length && s[i].h <= h; i++) v = s[i].v; return v; };
    var band = [], changes = [], prev = null;
    hs.forEach(function (h) {
      var top = 0, lead = [];
      keys.forEach(function (k) { var v = at(k, h); if (v > top) { top = v; lead = [k]; } else if (v === top && v > 0) lead.push(k); });
      var sig = lead.slice().sort().join(',');
      band.push({ h: h, leaders: lead, points: top });
      if (prev !== null && sig !== prev && lead.length) changes.push({ h: h, leaders: lead, before: prev ? prev.split(',') : [] });
      prev = sig;
    });
    return { band: band, changes: changes };
  }
  /* The tape's rows from a guild × sector history: one row per guild, sector
   * and bucket that moved, plus a row whenever a sector's lead changed hands. */
  function tapeRows(hist, startHeight) {
    var rows = [];
    ((hist && hist.samples) || []).forEach(function (r) {
      var du = num(r.unique_delta), dc = num(r.claim_delta), dp = num(r.points_delta);
      if (!du && !dc && !dp) return;
      rows.push({ kind: dc < 0 && du <= 0 ? 'lost' : dc > 0 ? 'claim' : 'win', h: num(r.height), from: num(r.start_height),
        guild_id: r.guild_id, sector: Number(r.sector), unique: du, claim: dc, points: dp });
    });
    var bySector = {};
    var series = seriesOf(hist, function (r) { return Number(r.sector) + '|' + r.guild_id; }, startHeight);
    Object.keys(series).forEach(function (k) { var s = k.split('|')[0]; (bySector[s] = bySector[s] || []).push(k); });
    Object.keys(bySector).forEach(function (s) {
      leadTimeline(series, bySector[s]).changes.forEach(function (c) {
        rows.push({ kind: 'lead', h: c.h, sector: Number(s), leaders: c.leaders.map(function (k) { return k.split('|')[1]; }),
          before: c.before.map(function (k) { return k.split('|')[1]; }) });
      });
    });
    rows.sort(function (a, b) { return b.h - a.h || (a.kind === 'lead' ? -1 : b.kind === 'lead' ? 1 : 0); });
    return rows;
  }
  function blocksAgo(blocks) {
    if (!(blocks > 0)) return 'now';
    return H.duration(Math.round(blocks * BLOCK_MS / 1000)) + ' ago';
  }

  // ── Reads ──
  var CACHE = {};
  /* One read shared by every card that asks within `ttl`. A failed read is
   * forgotten at once so the next card asks again. */
  function cached(key, ttl, fn) {
    var c = CACHE[key], now = Date.now();
    if (c && now - c.at < ttl) return c.p;
    var p = fn();
    CACHE[key] = { at: now, p: p };
    p.catch(function () { if (CACHE[key] && CACHE[key].p === p) delete CACHE[key]; });
    return p;
  }
  function api(path, query) { return invoke('terminal_influence', { path: path, query: query || null }); }
  function contests() {
    return cached('contests', 60000, function () { return api('contests', { limit: 100 }).then(function (e) { return (e && e.data) || []; }); });
  }
  function resolve(p) {
    return contests().then(function (list) {
      var c = pickContest(list, p && p.contest);
      if (!c) throw new Error(p && p.contest ? 'No contest #' + p.contest : 'No Sector Blitz contest yet');
      return { contest: c, all: list };
    });
  }
  /* Every guild in a contest, ranked overall, with its display profile. */
  function guildBook(cid) {
    return cached('book:' + cid, 30000, function () {
      return api('contests/' + cid + '/guilds', { limit: 1000, scored_only: 0 }).then(function (e) {
        var rows = (e && e.data) || [], byId = {};
        rows.forEach(function (r) { byId[r.guild_id] = r; });
        return { rows: rows, byId: byId, meta: (e && e.meta) || {} };
      });
    });
  }
  function standings(cid) {
    return cached('standings:' + cid, 20000, function () { return api('contests/' + cid + '/standings'); });
  }
  /* Our own standing: the primary's personal row, which also names the
   * guild we score for (`standing` is null before our first scoring raid).
   * Rust knows who the primary is; the board does not. */
  var ME = { id: null };
  function meId() { return ME.id; }
  function mine(cid) {
    return cached('me:' + cid, 30000, function () {
      return invoke('terminal_influence_me', { contest: Number(cid) }).then(function (r) {
        if (r && r.player_id) ME.id = r.player_id;
        return (r && r.standing) || null;
      });
    }).catch(function () { return null; });
  }

  // ── Shared drawing ──
  function guildName(book, id) {
    var r = book && book.byId[id], pr = r && r.profile;
    if (pr && pr.tag) return '[' + pr.tag + '] ' + (pr.name || id);
    return (pr && pr.name) || id;
  }
  function guildTag(book, id) {
    var r = book && book.byId[id], pr = r && r.profile;
    return (pr && (pr.tag || pr.name)) || id;
  }
  function rankCls(book, id) {
    var r = book && book.byId[id], k = r ? num(r.rank) - 1 : -1;
    return k >= 0 && k < RANK_CLS.length ? RANK_CLS[k] : OTHER_CLS;
  }
  function swatch(cls) { return H.el('i', 'ipc-sw ' + cls); }
  function light(sector) {
    var s = sectorOf(sector);
    if (!s) return null;
    var img = H.el('img', 'ipc-light');
    img.src = 'img/sector-blitz/sector-light-' + s.light + '.gif';
    img.alt = '';
    return img;
  }
  function ipIcon() { return H.el('i', 'sui-icon ' + IP_ICON); }
  function link(text, onClick, cls) {
    var a = H.el('a', 'ipc-link' + (cls ? ' ' + cls : ''), text);
    a.href = 'javascript:void(0)';
    a.addEventListener('click', function (ev) { ev.stopPropagation(); onClick(); });
    return a;
  }
  function doorRow(items) {
    var row = H.el('div', 'tm-doors-row');
    items.forEach(function (it) {
      if (!it) return;
      var a = H.el('a', 'sui-screen-btn ' + (it.primary ? 'sui-mod-primary' : 'sui-mod-secondary'), it.label);
      a.href = 'javascript:void(0)';
      a.addEventListener('click', it.onClick);
      row.appendChild(a);
    });
    return row;
  }
  function section(host, title, aside) {
    var head = H.el('div', 'ipc-sec');
    head.appendChild(H.el('span', 'sui-text-header', title));
    if (aside) head.appendChild(aside.nodeType ? aside : H.el('span', 'sui-text-hint ipc-aside', aside));
    host.appendChild(head);
    return head;
  }
  function tiles(list) {
    var strip = H.el('div', 'hstrip tm-tiles ipc-tiles');
    list.forEach(function (t) { if (!t) return; var n = H.statTile(t[0], t[1], null, t[2]); if (t[3]) n.title = t[3]; strip.appendChild(n); });
    return strip;
  }
  /* Every card ends on where its numbers come from and how fresh they are:
   * the contest, the published build, the block it is scored to. */
  function foot(host, c, meta, extra) {
    var m = meta || {};
    var bits = ['Contest #' + c.contest_id];
    if (m.build_id || c.build_id) bits.push('build ' + (m.build_id || c.build_id));
    var h = m.height || c.projected_height;
    if (h) bits.push('scored to ' + fmt(h));
    if (extra) bits.push(extra);
    var f = H.el('div', 'ipc-foot sui-text-hint', bits.join(' · '));
    if (m.source_height && m.height && num(m.source_height) > num(m.height)) f.title = 'Chain indexed to ' + fmt(m.source_height);
    host.appendChild(f);
  }
  function failed(host, e) {
    host.innerHTML = '';
    var msg = errText(e);
    var kind = /no complete published|not found|No Sector Blitz|No contest/i.test(msg) ? 'info' : 'error';
    host.appendChild(H.stateBlock(kind, msg));
  }
  function loading(host, text) { if (!host.firstChild) host.appendChild(H.stateBlock('loading', text)); }
  function watchPlanet(planetId) {
    if (!planetId) return;
    if (Board.canSpectate && Board.canSpectate() && Board.openSpectatorWindow) {
      Board.openSpectatorWindow({ planet_id: planetId }).catch(function () { add('planet', { id: planetId }); });
    } else add('planet', { id: planetId });
  }
  function openPlayer(id) { add('player', { id: id }); }
  function openGuild(id) { add('guild', { id: id }); }
  function openIP(id) { add('influence', { id: id }); }
  /* The game's own raid-row badge (RaidTarget.statusBadgeHTML). */
  function targetBadge(profile) {
    if (!profile) return null;
    var ua = profile.under_attack === true || Number(profile.under_attack) === 1;
    if (ua) return { text: 'UNDER ATTACK', mod: 'destructive' };
    if (profile.fleet_status === 'away') return { text: 'FLEET AWAY', mod: 'default' };
    return { text: 'ON STATION', mod: 'warning' };
  }
  function sectorChoice(p, fallback) {
    var s = p && p.sector != null && p.sector !== '' ? Number(p.sector) : fallback;
    return sectorOf(s) || s === 0 ? s : fallback;
  }
  /* `STANDINGS 127`, `LEADERS guilds 999` — the words after a card's word,
   * read the same way by every contest card: a sector number, a contest
   * as `#2`, and the card's own keywords. */
  function argsParser(keywords) {
    return function (rest) {
      var out = {};
      String(rest || '').trim().split(/\s+/).filter(Boolean).forEach(function (w) {
        var lw = w.toLowerCase().replace(/^0+(?=\d)/, '');
        if (/^#\d+$/.test(lw)) out.contest = lw.slice(1);
        else if (sectorOf(lw)) out.sector = String(Number(lw));
        else if (keywords && keywords[lw]) Object.assign(out, keywords[lw]);
      });
      return out;
    };
  }

  // ── CONTEST ─────────────────────────────────────────────────────────────
  T.register('contest', {
    label: 'Contest', describe: function (p) { return 'Sector Blitz' + (p && p.contest ? ' #' + p.contest : ''); },
    cadenceMs: 60000, argHint: '[#contest]', parseArgs: argsParser(),
    params: [{ key: 'contest', label: 'Contest number (blank = current)', kind: 'text', placeholder: '2' }],
    render: function (host, p, ctx) {
      loading(host, 'Reading the contest');
      return resolve(p).then(function (r) {
        var c = r.contest;
        return Promise.all([
          c.data_ready ? standings(c.contest_id) : Promise.resolve(null),
          c.data_ready ? guildBook(c.contest_id) : Promise.resolve(null),
        ]).then(function (res) { drawContest(host, p, ctx, c, r.all, res[0], res[1]); });
      }).catch(function (e) { failed(host, e); });
    },
  });
  function drawContest(host, p, ctx, c, all, st, book) {
    host.innerHTML = '';
    var wrap = H.el('div', 'ipc');
    var meta = (st && st.meta) || {};
    var h = num(meta.height || c.projected_height), start = num(c.start_height), end = num(c.end_height);
    var status = STATUS[c.status] || [c.status, 'default'];
    var top = H.el('div', 'ipc-row-line');
    top.appendChild(H.badge(status[0].toUpperCase(), status[1]));
    top.appendChild(H.el('span', 'sui-text-hint', c.scoring_mode === 'single_sector' ? 'One sector' : 'Planet sectors'));
    wrap.appendChild(top);
    var left = end - h;
    var clock = c.status === 'scheduled' ? ['Starts in', fmt(start - h) + ' blocks'] :
      c.status === 'active' ? ['Blocks left', fmt(Math.max(0, left))] : ['Ended at', fmt(end)];
    wrap.appendChild(tiles([
      [clock[0], clock[1]],
      c.status === 'active' ? ['About', H.duration(Math.round(Math.max(0, left) * BLOCK_MS / 1000))] : null,
      ['Unique win', fmt(c.win_points) + ' IP'],
      ['Claim held', fmt(c.claim_points) + ' IP'],
    ]));
    var bar = H.progressBar(end > start ? (h - start) / (end - start) : 0);
    bar.title = fmt(start) + ' → ' + fmt(end);
    wrap.appendChild(bar);

    if (st && book) {
      var sectors = scoringSectors(c);
      var mx = matrix(st.data, sectors);
      section(wrap, 'Sector control', link('Standings', function () { add('standings', {}); }));
      sectors.forEach(function (s) {
        var row = H.el('a', 'ipc-srow');
        row.href = 'javascript:void(0)';
        row.addEventListener('click', function () { add('standings', { sector: String(s) }); });
        var l = light(s); if (l) row.appendChild(l);
        var mid = H.el('div', 'ipc-grow');
        mid.appendChild(H.el('div', 'sui-text-label', sectorLabel(s, c.scoring_mode)));
        var who = H.el('div', 'ipc-who');
        var leads = mx.leaders[s];
        if (!leads.length) who.appendChild(H.el('span', 'sui-text-hint', 'No points yet'));
        leads.forEach(function (g, i) {
          if (i) who.appendChild(H.el('span', 'sui-text-hint', ' = '));
          who.appendChild(swatch(rankCls(book, g)));
          who.appendChild(H.el('span', null, guildTag(book, g)));
        });
        mid.appendChild(who);
        row.appendChild(mid);
        var right = H.el('div', 'ipc-right');
        right.appendChild(H.el('div', null, fmt(mx.top[s])));
        var second = mx.guilds.map(function (g) { return g.cells[s] ? g.cells[s].points : 0; }).filter(function (v) { return v < mx.top[s]; }).sort(function (a, b) { return b - a; })[0] || 0;
        right.appendChild(H.el('div', 'sui-text-hint', leads.length > 1 ? 'Tied lead' : leads.length ? 'by ' + fmt(mx.top[s] - second) : ''));
        row.appendChild(right);
        wrap.appendChild(row);
      });
      var lead = book.rows[0];
      if (lead) {
        section(wrap, c.status === 'final' ? 'Won by' : 'Winning now');
        wrap.appendChild(window.StructsGuildCard.row({
          id: lead.guild_id, name: lead.profile && lead.profile.name, tag: lead.profile && lead.profile.tag, logo: lead.profile && lead.profile.logo,
          prefix: '#' + lead.rank,
          readings: [{ value: lead.sectors_controlled + ' sector' + (num(lead.sectors_controlled) === 1 ? '' : 's') },
            { value: fmt(lead.overall_points), icon: IP_ICON, title: 'Influence points, all sectors' }],
        }, { onClick: function () { openIP(lead.guild_id); },
          actions: [{ icon: 'icon-guild', title: 'Guild', onClick: function () { openGuild(lead.guild_id); } }] }));
      }
    } else if (!c.data_ready) {
      wrap.appendChild(H.stateBlock('info', 'This contest has no published scores yet'));
    }

    var others = (all || []).filter(function (o) { return String(o.contest_id) !== String(c.contest_id); });
    if (others.length) {
      section(wrap, 'Other contests');
      others.slice().sort(function (a, b) { return num(b.contest_id) - num(a.contest_id); }).slice(0, 6).forEach(function (o) {
        var st2 = STATUS[o.status] || [o.status];
        var row = H.el('a', 'ipc-srow ipc-thin');
        row.href = 'javascript:void(0)';
        row.addEventListener('click', function () { T.setParams(ctx.id, Object.assign({}, p, { contest: String(o.contest_id) })); });
        row.appendChild(H.el('span', 'sui-text-label ipc-num', '#' + o.contest_id));
        row.appendChild(H.el('span', 'ipc-grow', st2[0]));
        row.appendChild(H.el('span', 'sui-text-hint', (o.status === 'scheduled' ? 'starts ' + fmt(o.start_height) : 'ends ' + fmt(o.end_height))));
        wrap.appendChild(row);
      });
      if (p.contest) wrap.appendChild(doorRow([{ label: 'Current contest', onClick: function () { T.setParams(ctx.id, Object.assign({}, p, { contest: '' })); } }]));
    }
    foot(wrap, c, meta);
    host.appendChild(wrap);
    if (ctx && ctx.id) T.retitle(ctx.id, 'Sector Blitz #' + c.contest_id);
  }

  // ── STANDINGS ───────────────────────────────────────────────────────────
  T.register('standings', {
    label: 'Sector standings', describe: function (p) { return 'Standings' + (p && p.sector ? ' · ' + sectorLabel(p.sector) : ''); },
    cadenceMs: 30000, defaultWidth: 2, argHint: '[sector]', parseArgs: argsParser(),
    params: [{ key: 'sector', label: 'Path to the lead in', kind: 'choice', options: [{ value: '', label: 'Where we trail' }].concat(SCORING_OPTS) },
      { key: 'contest', label: 'Contest number (blank = current)', kind: 'text', placeholder: '2' }],
    render: function (host, p, ctx) {
      loading(host, 'Reading the scoreboard');
      return resolve(p).then(function (r) {
        var c = r.contest;
        return Promise.all([standings(c.contest_id), guildBook(c.contest_id), mine(c.contest_id)]).then(function (res) {
          drawStandings(host, p, ctx, c, res[0], res[1], res[2]);
        });
      }).catch(function (e) { failed(host, e); });
    },
  });
  function drawStandings(host, p, ctx, c, st, book, me) {
    host.innerHTML = '';
    var wrap = H.el('div', 'ipc');
    var sectors = scoringSectors(c);
    var mx = matrix(st.data, sectors);
    var myGuild = me && me.guild_id;
    if (!mx.guilds.length) { wrap.appendChild(H.stateBlock('info', 'No guild has scored yet')); foot(wrap, c, st.meta); host.appendChild(wrap); return; }
    // The focus sector: the one asked for, else the first where we trail.
    var focus = p.sector ? Number(p.sector) : null;
    if (focus == null) {
      focus = sectors.filter(function (s) { return myGuild && mx.leaders[s].indexOf(myGuild) < 0; })[0];
      if (focus == null) focus = sectors[0];
    }
    var table = H.el('table', 'ipc-table');
    var thead = H.el('thead'), hr = H.el('tr');
    hr.appendChild(H.el('th', 'sui-text-header ipc-l', 'Guild'));
    sectors.forEach(function (s) {
      var th = H.el('th', 'sui-text-header' + (s === focus ? ' ipc-focus' : ''));
      var a = H.el('a', 'ipc-th');
      a.href = 'javascript:void(0)';
      var l = light(s); if (l) a.appendChild(l);
      a.appendChild(document.createTextNode(c.scoring_mode === 'single_sector' ? 'All' : String(s).padStart(3, '0')));
      a.title = 'Path to the lead in ' + sectorLabel(s, c.scoring_mode);
      a.addEventListener('click', function () { T.setParams(ctx.id, Object.assign({}, p, { sector: String(s) })); });
      th.appendChild(a);
      hr.appendChild(th);
    });
    hr.appendChild(H.el('th', 'sui-text-header', 'Overall'));
    hr.appendChild(H.el('th', 'sui-text-header', 'Held'));
    thead.appendChild(hr); table.appendChild(thead);
    var tb = H.el('tbody');
    mx.guilds.forEach(function (g) {
      var tr = H.el('tr', g.guild_id === myGuild ? 'ipc-mine' : '');
      var name = H.el('td', 'ipc-l');
      var a = link('', function () { openIP(g.guild_id); });
      a.appendChild(swatch(rankCls(book, g.guild_id)));
      a.appendChild(document.createTextNode(guildTag(book, g.guild_id)));
      a.title = guildName(book, g.guild_id) + ' · ' + g.guild_id;
      name.appendChild(a);
      tr.appendChild(name);
      sectors.forEach(function (s) {
        var cell = g.cells[s] || { points: 0 };
        var leads = mx.leaders[s].indexOf(g.guild_id) >= 0;
        var tied = leads && mx.leaders[s].length > 1;
        var td = H.el('td', (tied ? 'ipc-tie' : leads ? 'ipc-lead' : '') + (s === focus ? ' ipc-focus' : ''));
        td.appendChild(H.el('div', null, fmt(cell.points)));
        td.appendChild(H.el('div', 'sui-text-hint', cell.winner ? 'Winner' : tied ? 'Tied' : leads ? 'Controls' : cell.points ? '−' + fmt(mx.top[s] - cell.points) : '—'));
        tr.appendChild(td);
      });
      var r = book.byId[g.guild_id];
      var ov = H.el('td');
      ov.appendChild(H.el('div', null, fmt(g.overall)));
      ov.appendChild(H.el('div', 'sui-text-hint', r ? '#' + r.rank : ''));
      tr.appendChild(ov);
      tr.appendChild(H.el('td', null, fmt(g.held)));
      tb.appendChild(tr);
    });
    table.appendChild(tb);
    var scroll = H.el('div', 'ipc-scroll');
    scroll.appendChild(table);
    wrap.appendChild(scroll);

    // The path to the lead in the focus sector, for every guild behind it.
    var leaders = mx.leaders[focus];
    var leaderHeld = leaders.length === 1 ? (mx.byGuild[leaders[0]].cells[focus] || {}).held : null;
    section(wrap, 'Path to the lead · ' + sectorLabel(focus, c.scoring_mode),
      leaders.length ? 'Lead ' + fmt(mx.top[focus]) + ' · ' + leaders.map(function (g) { return guildTag(book, g); }).join(' = ') : 'Nobody has scored');
    var pt = H.el('table', 'ipc-table');
    var ph = H.el('tr');
    ['Guild', 'Gap', 'Unique wins', 'Claims taken'].forEach(function (t, i) { ph.appendChild(H.el('th', 'sui-text-header' + (i ? '' : ' ipc-l'), t)); });
    var phd = H.el('thead'); phd.appendChild(ph); pt.appendChild(phd);
    var pb = H.el('tbody');
    mx.guilds.slice().sort(function (a, b) { return ((b.cells[focus] || {}).points || 0) - ((a.cells[focus] || {}).points || 0); }).slice(0, 8).forEach(function (g) {
      var pts = (g.cells[focus] || {}).points || 0;
      var gap = mx.top[focus] - pts;
      var tr = H.el('tr', g.guild_id === myGuild ? 'ipc-mine' : '');
      var nm = H.el('td', 'ipc-l'); nm.appendChild(swatch(rankCls(book, g.guild_id))); nm.appendChild(document.createTextNode(guildTag(book, g.guild_id)));
      tr.appendChild(nm);
      if (gap <= 0 && mx.top[focus] > 0) {
        tr.appendChild(H.el('td', null, leaders.length > 1 ? 'tied' : 'leads'));
        tr.appendChild(H.el('td', null, leaders.length > 1 ? '1 breaks it' : '—'));
        tr.appendChild(H.el('td', null, '—'));
      } else {
        var path = pathToLead(gap, c.win_points, c.claim_points, leaderHeld);
        tr.appendChild(H.el('td', null, fmt(gap)));
        tr.appendChild(H.el('td', null, (path.tie != null ? path.tie + ' tie · ' : '') + path.pass + ' pass'));
        var fl = H.el('td', path.flipsPossible ? null : 'sui-text-hint', path.flips == null ? '—' : String(path.flips));
        if (!path.flipsPossible) fl.title = 'The leader holds only ' + leaderHeld + ' claims here';
        tr.appendChild(fl);
      }
      pb.appendChild(tr);
    });
    pt.appendChild(pb);
    wrap.appendChild(pt);
    foot(wrap, c, st.meta, 'ranks by sector points, then overall');
    host.appendChild(wrap);
  }

  // ── RACE ────────────────────────────────────────────────────────────────
  var RACE = {};
  var SVGNS = 'http://www.w3.org/2000/svg';
  function svg(tag, attrs, cls) {
    var n = document.createElementNS(SVGNS, tag);
    Object.keys(attrs || {}).forEach(function (k) { n.setAttribute(k, attrs[k]); });
    if (cls) n.setAttribute('class', cls);
    return n;
  }
  T.register('race', {
    label: 'Influence race', describe: function (p) { return 'Race' + (p && p.sector ? ' · ' + sectorLabel(p.sector) : ''); },
    cadenceMs: 60000, defaultWidth: 3, argHint: '[sector]', parseArgs: argsParser(),
    params: [{ key: 'sector', label: 'Sector', kind: 'choice', options: SECTOR_OPTS },
      { key: 'contest', label: 'Contest number (blank = current)', kind: 'text', placeholder: '2' }],
    render: function (host, p, ctx) {
      loading(host, 'Reading the history');
      var st = RACE[ctx.id] || (RACE[ctx.id] = { hidden: {} });
      return resolve(p).then(function (r) {
        var c = r.contest, start = num(c.start_height);
        var end = Math.min(num(c.projected_height), num(c.end_height));
        if (!(end >= start)) throw new Error('The contest starts at block ' + fmt(start));
        start = Math.max(start, end - 999999);
        var bucket = bucketFor(end - start + 1, 120);
        var q = { start_height: start, end_height: end, bucket_blocks: bucket, group_by: 'guild', sector: p.sector || null };
        var read = api('contests/' + c.contest_id + '/history', q).catch(function (e) {
          // Too many guilds × samples for one answer: ask in coarser buckets.
          if (!/ 422 /.test(String(e))) throw e;
          q.bucket_blocks = bucketFor(end - start + 1, 30);
          return api('contests/' + c.contest_id + '/history', q);
        });
        return Promise.all([read, guildBook(c.contest_id), mine(c.contest_id)]).then(function (res) {
          drawRace(host, p, ctx, st, c, res[0], res[1], res[2], start, end);
        });
      }).catch(function (e) { failed(host, e); });
    },
    unmount: function (host, p, ctx) { if (ctx) delete RACE[ctx.id]; },
  });
  function drawRace(host, p, ctx, st, c, hist, book, me, start, end) {
    host.innerHTML = '';
    var wrap = H.el('div', 'ipc');
    var series = seriesOf(hist.data, function (r) { return r.guild_id; }, start);
    var last = function (k) { var s = series[k]; return s && s.length ? s[s.length - 1].v : 0; };
    var keys = Object.keys(series).filter(function (k) { return last(k) > 0; }).sort(function (a, b) { return last(b) - last(a); });
    var myGuild = me && me.guild_id;
    var shown = keys.slice(0, SERIES_CLS.length);
    if (myGuild && keys.indexOf(myGuild) >= SERIES_CLS.length) shown[shown.length - 1] = myGuild;
    if (!shown.length) { wrap.appendChild(H.stateBlock('info', 'Nobody has scored' + (p.sector ? ' in ' + sectorLabel(p.sector) : '') + ' yet')); foot(wrap, c, hist.meta); host.appendChild(wrap); return; }
    var cls = {}; shown.forEach(function (k, i) { cls[k] = SERIES_CLS[i]; });
    var cEnd = num(c.end_height), x0 = 56, x1 = 668, y0 = 300, y1 = 16;
    var paceWin = Math.min(10000, Math.max(1000, Math.round((end - start) / 5)));
    var proj = {};
    shown.forEach(function (k) { proj[k] = last(k) + paceOf(series[k], paceWin) * (cEnd - end) / 1000; });
    var maxV = Math.max(1, Math.max.apply(null, shown.map(function (k) { return Math.max(last(k), proj[k]); })));
    var topV = Math.ceil(maxV * 1.08 / 400) * 400;
    var X = function (h) { return x0 + (x1 - x0) * (h - start) / Math.max(1, cEnd - start); };
    var Y = function (v) { return y0 - (y0 - y1) * v / topV; };
    var chart = svg('svg', { viewBox: '0 0 680 344', role: 'img', 'aria-label': 'Influence points by guild over block height' }, 'ipc-chart');
    [0, 0.25, 0.5, 0.75, 1].forEach(function (f) {
      chart.appendChild(svg('line', { x1: x0, x2: x1, y1: Y(topV * f), y2: Y(topV * f) }, 'ipc-grid'));
      var t = svg('text', { x: x0 - 6, y: Y(topV * f) + 3, 'text-anchor': 'end' }, 'ipc-axis'); t.textContent = H.fmtInt(topV * f); chart.appendChild(t);
    });
    if (cEnd > end) {
      chart.appendChild(svg('rect', { x: X(end), y: y1, width: x1 - X(end), height: y0 - y1 }, 'ipc-future'));
      chart.appendChild(svg('line', { x1: X(end), x2: X(end), y1: y1, y2: y0 }, 'ipc-now'));
    }
    shown.forEach(function (k) {
      if (st.hidden[k]) return;
      var d = '';
      series[k].forEach(function (pt, i) { d += i ? ' H' + X(pt.h).toFixed(1) + ' V' + Y(pt.v).toFixed(1) : 'M' + X(Math.max(start, pt.h)).toFixed(1) + ' ' + Y(pt.v).toFixed(1); });
      chart.appendChild(svg('path', { d: d }, 'ipc-line ' + cls[k] + (k === myGuild ? ' ipc-line-mine' : '')));
      if (cEnd > end) chart.appendChild(svg('path', { d: 'M' + X(end).toFixed(1) + ' ' + Y(last(k)).toFixed(1) + ' L' + X(cEnd).toFixed(1) + ' ' + Y(proj[k]).toFixed(1) }, 'ipc-line ipc-proj ' + cls[k]));
    });
    var lt = leadTimeline(series, keys);
    lt.band.forEach(function (b, i) {
      var nx = i + 1 < lt.band.length ? lt.band[i + 1].h : end;
      var k = b.leaders.length === 1 ? b.leaders[0] : null;
      chart.appendChild(svg('rect', { x: X(Math.max(start, b.h)), y: 318, width: Math.max(0.5, X(nx) - X(Math.max(start, b.h)) - 0.5), height: 8 },
        'ipc-band ' + (k ? (cls[k] || OTHER_CLS) : b.leaders.length ? 'ipc-band-tie' : 'ipc-band-none')));
    });
    var tl = svg('text', { x: x0 - 6, y: 326, 'text-anchor': 'end' }, 'ipc-axis'); tl.textContent = 'LEAD'; chart.appendChild(tl);
    var ts = svg('text', { x: x0, y: 340 }, 'ipc-axis'); ts.textContent = fmt(start); chart.appendChild(ts);
    var te = svg('text', { x: x1, y: 340, 'text-anchor': 'end' }, 'ipc-axis'); te.textContent = (cEnd > end ? 'END ' : '') + fmt(cEnd); chart.appendChild(te);

    var body = H.el('div', 'ipc-race');
    var fig = H.el('div', 'ipc-race-chart'); fig.appendChild(chart); body.appendChild(fig);
    var side = H.el('div', 'ipc-race-side');
    var lg = H.el('table', 'ipc-table');
    var lh = H.el('tr');
    ['Guild', 'Now', '/1k', cEnd > end ? 'At end' : ''].forEach(function (t, i) { lh.appendChild(H.el('th', 'sui-text-header' + (i ? '' : ' ipc-l'), t)); });
    var lhd = H.el('thead'); lhd.appendChild(lh); lg.appendChild(lhd);
    var lb = H.el('tbody');
    var bestEnd = Math.max.apply(null, shown.map(function (k) { return proj[k]; }));
    shown.forEach(function (k) {
      var tr = H.el('tr', 'ipc-toggle' + (st.hidden[k] ? ' ipc-off' : '') + (k === myGuild ? ' ipc-mine' : ''));
      tr.title = st.hidden[k] ? 'Show this guild' : 'Hide this guild';
      tr.addEventListener('click', function () { st.hidden[k] = !st.hidden[k]; drawRace(host, p, ctx, st, c, hist, book, me, start, end); });
      var nm = H.el('td', 'ipc-l'); nm.appendChild(swatch(cls[k])); nm.appendChild(document.createTextNode(guildTag(book, k)));
      tr.appendChild(nm);
      tr.appendChild(H.el('td', null, fmt(last(k))));
      tr.appendChild(H.el('td', 'sui-text-hint', '+' + H.fmtInt(Math.round(paceOf(series[k], paceWin)))));
      tr.appendChild(H.el('td', cEnd > end && proj[k] === bestEnd ? 'sui-text-warning' : null, cEnd > end ? fmt(Math.round(proj[k])) : ''));
      lb.appendChild(tr);
    });
    lg.appendChild(lb);
    side.appendChild(lg);
    if (keys.length > shown.length) side.appendChild(H.el('div', 'sui-text-hint ipc-note', (keys.length - shown.length) + ' more guilds scored'));
    // A first lead taken from nobody is not a change of hands.
    var handed = lt.changes.filter(function (ch) { return ch.before.length; });
    var changes = handed.slice(-6).reverse();
    if (changes.length) {
      section(side, 'Lead changes', String(handed.length));
      changes.forEach(function (ch) {
        var row = H.el('div', 'ipc-srow ipc-thin');
        ch.leaders.forEach(function (k) { row.appendChild(swatch(cls[k] || OTHER_CLS)); });
        row.appendChild(H.el('span', 'ipc-grow', ch.leaders.map(function (k) { return guildTag(book, k); }).join(' = ')
          + (ch.leaders.length > 1 ? ' tie' : ' leads')));
        row.appendChild(H.el('span', 'sui-text-hint', fmt(ch.h)));
        side.appendChild(row);
      });
    }
    body.appendChild(side);
    wrap.appendChild(body);
    foot(wrap, c, hist.meta, 'bucket ' + fmt(hist.meta && hist.meta.bucket_blocks) + ' · dashed = pace of the last ' + fmt(paceWin) + ' blocks');
    host.appendChild(wrap);
  }

  // ── TERRITORY ───────────────────────────────────────────────────────────
  var TERR = {};
  var TERR_MODES = [{ key: 'claims', label: 'Claims' }, { key: 'coverage', label: 'Coverage' }, { key: 'worth', label: 'Worth to us' }];
  T.register('territory', {
    label: 'Sector territory', describe: function (p) { return 'Territory · ' + sectorLabel(p && p.sector || 44); },
    cadenceMs: 60000, defaultWidth: 2, argHint: '<sector>', parseArgs: argsParser(),
    params: [{ key: 'sector', label: 'Sector', kind: 'choice', options: SCORING_OPTS },
      { key: 'mode', label: 'Colour by', kind: 'choice', options: TERR_MODES.map(function (m) { return { value: m.key, label: m.label }; }) },
      { key: 'contest', label: 'Contest number (blank = current)', kind: 'text', placeholder: '2' }],
    render: function (host, p, ctx) {
      var sector = sectorChoice(p, 44);
      loading(host, 'Reading every planet in ' + sectorLabel(sector));
      var st = TERR[ctx.id] || (TERR[ctx.id] = { sel: null });
      return resolve(p).then(function (r) {
        var c = r.contest;
        return Promise.all([
          invoke('terminal_influence_territory', { contest: Number(c.contest_id), sector: sector }),
          guildBook(c.contest_id), mine(c.contest_id),
        ]).then(function (res) { drawTerritory(host, p, ctx, st, c, sector, res[0], res[1], res[2]); });
      }).catch(function (e) { failed(host, e); });
    },
    unmount: function (host, p, ctx) { if (ctx) delete TERR[ctx.id]; },
  });
  function drawTerritory(host, p, ctx, st, c, sector, d, book, me) {
    host.innerHTML = '';
    var wrap = H.el('div', 'ipc');
    var mode = p.mode || 'claims';
    var myGuild = me && me.guild_id;
    var planets = d.planets || [];
    wrap.appendChild(H.navStrip(TERR_MODES, mode, function (k) { T.setParams(ctx.id, Object.assign({}, p, { mode: k })); }));
    if (!planets.length) { wrap.appendChild(H.stateBlock('info', 'The snapshot has no planets in ' + sectorLabel(sector))); foot(wrap, c, d.meta); host.appendChild(wrap); return; }
    var inf = function (pl) { return pl.influence && pl.influence.exists ? pl.influence : null; };
    var raided = planets.filter(inf).length;
    var ours = planets.filter(function (pl) { var i = inf(pl); return i && myGuild && i.holder_guild_id === myGuild; }).length;
    var worth = function (pl) { return worthFor(inf(pl) || { guild_coverage: [] }, myGuild, c.win_points, c.claim_points, pl.owner_guild_id); };
    var full = myGuild ? planets.filter(function (pl) { var w = worth(pl); return w && w.total >= num(c.win_points) + num(c.claim_points); }).length : null;
    wrap.appendChild(tiles([
      ['Planets', fmt(d.total) + (d.cut ? '+' : '')],
      ['Raided', fmt(raided)],
      myGuild ? ['Our claims', fmt(ours)] : null,
      myGuild ? ['Worth the most', fmt(full), 'sui-text-warning'] : null,
    ]));
    var body = H.el('div', 'ipc-terr');
    var grid = H.el('div', 'ipc-cells');
    var counts = {};
    planets.forEach(function (pl, i) {
      var i2 = inf(pl), cellCls = 'ipc-cell';
      if (mode === 'claims') {
        if (i2 && i2.holder_guild_id) { cellCls += ' ' + rankCls(book, i2.holder_guild_id); counts[i2.holder_guild_id] = (counts[i2.holder_guild_id] || 0) + 1; }
        else if (i2) cellCls += ' ipc-cell-open';
      } else if (mode === 'coverage') {
        var n = i2 ? (i2.guild_coverage || []).length : 0;
        if (n) cellCls += ' ipc-depth' + Math.min(4, n);
      } else {
        var w = worth(pl);
        cellCls += !w ? '' : w.own ? ' ipc-cell-own' : w.total >= num(c.win_points) + num(c.claim_points) ? ' ipc-w3' : w.claim ? ' ipc-w2' : w.unique ? ' ipc-w1' : ' ipc-cell-open';
      }
      if (st.sel === pl.planet_id) cellCls += ' ipc-sel';
      var b = H.el('button', cellCls);
      b.type = 'button';
      b.title = pl.planet_id + (pl.name ? ' · ' + pl.name : '');
      b.setAttribute('aria-label', b.title);
      b.addEventListener('click', function () { st.sel = pl.planet_id; drawTerritory(host, p, ctx, st, c, sector, d, book, me); });
      grid.appendChild(b);
    });
    body.appendChild(grid);
    var detail = H.el('div', 'ipc-detail');
    var sel = planets.filter(function (pl) { return pl.planet_id === st.sel; })[0];
    if (!sel) detail.appendChild(H.el('div', 'sui-text-hint', 'Pick a planet'));
    else drawPlanetFacts(detail, c, book, myGuild, inf(sel), sel.planet_id, sel.owner, sel.owner_guild_id, true);
    body.appendChild(detail);
    wrap.appendChild(body);
    var legend = H.el('div', 'ipc-legend');
    var key = function (clsName, text) { var s = H.el('span', 'sui-text-hint'); s.appendChild(swatch(clsName)); s.appendChild(document.createTextNode(text)); legend.appendChild(s); };
    if (mode === 'claims') {
      Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; }).slice(0, 6).forEach(function (g) { key(rankCls(book, g), guildTag(book, g) + ' ' + counts[g]); });
      key('ipc-cell-open', 'Raided, unclaimed');
    } else if (mode === 'coverage') {
      [1, 2, 3, 4].forEach(function (n) { key('ipc-depth' + n, n + (n === 4 ? '+' : '') + ' guild' + (n > 1 ? 's' : '')); });
    } else if (myGuild) {
      key('ipc-w3', '+' + fmt(num(c.win_points) + num(c.claim_points))); key('ipc-w2', '+' + fmt(c.claim_points)); key('ipc-w1', '+' + fmt(c.win_points)); key('ipc-cell-own', 'Our guild');
    } else legend.appendChild(H.el('span', 'sui-text-hint', 'Score once to see what planets are worth to your guild'));
    wrap.appendChild(legend);
    foot(wrap, c, d.meta, d.mixed_builds ? 'a rebuild landed mid-read' : null);
    host.appendChild(wrap);
    if (ctx && ctx.id) T.retitle(ctx.id, 'Territory · ' + sectorLabel(sector));
  }
  /* A planet's contest facts — the claim, the last win, who is credited and
   * what a win would be worth — used by TERRITORY's side panel and IP. */
  function drawPlanetFacts(host, c, book, myGuild, i2, planetId, owner, ownerGuild, compact) {
    var head = H.el('div', 'ipc-row-line');
    head.appendChild(H.el('span', 'sui-text-label', planetId));
    head.appendChild(H.el('span', 'sui-text-hint', i2 ? 'Contested' : 'No wins yet'));
    host.appendChild(head);
    var fact = function (label, value) { host.appendChild(H.fact(label, value)); };
    var person = function (id) {
      if (!id) return '—';
      var a = link(id, function () { openPlayer(id); });
      T.playerName(id).then(function (n) { if (n) a.textContent = n; });
      return a;
    };
    if (owner) fact('Owner', (function () { var s = H.el('span'); s.appendChild(person(owner)); if (ownerGuild) s.appendChild(document.createTextNode(' · ' + guildTag(book, ownerGuild))); return s; })());
    if (i2) {
      var claim = H.el('span');
      if (i2.holder) { claim.appendChild(person(i2.holder)); claim.appendChild(document.createTextNode(' · ' + (i2.holder_guild_id ? guildTag(book, i2.holder_guild_id) : 'no guild'))); }
      else claim.textContent = 'Nobody';
      fact('Claim', claim);
      var lr = i2.latest_raid;
      if (lr) {
        var last = H.el('span');
        last.appendChild(person(lr.attacker));
        last.appendChild(document.createTextNode(' (' + (lr.attacker_guild ? guildTag(book, lr.attacker_guild) : '—') + ') beat '));
        last.appendChild(person(lr.defender));
        last.appendChild(document.createTextNode(' · ' + fmt(lr.height)));
        fact('Last win', last);
      }
      var cov = H.el('span');
      (i2.guild_coverage || []).forEach(function (g, i) {
        if (i) cov.appendChild(document.createTextNode(' · '));
        cov.appendChild(swatch(rankCls(book, g.guild_id)));
        cov.appendChild(document.createTextNode(guildTag(book, g.guild_id) + ' ×' + g.supporter_count));
      });
      if (!cov.firstChild) cov.textContent = '—';
      fact('Credited', cov);
    }
    var w = worthFor(i2 || { guild_coverage: [] }, myGuild, c.win_points, c.claim_points, ownerGuild);
    if (w) fact('Worth to us', w.own ? 'Our own guild' : '+' + fmt(w.total) + ' IP' + (w.total ? ' (' + [w.unique ? 'unique' : null, w.claim ? 'claim' : null].filter(Boolean).join(' + ') + ')' : ''));
    host.appendChild(doorRow([
      { label: 'Map', primary: true, onClick: function () { watchPlanet(planetId); } },
      compact ? { label: 'IP', onClick: function () { openIP(planetId); } } : null,
      owner ? { label: 'Owner', onClick: function () { openPlayer(owner); } } : null,
    ]));
  }

  // ── IP <guild|player|planet> ────────────────────────────────────────────
  T.register('influence', {
    label: 'Influence dossier', describe: function (p) { return 'IP ' + (p && p.id || '?'); },
    cadenceMs: 30000, defaultWidth: 2,
    params: [{ key: 'id', label: 'Guild, player or planet id', kind: 'id', kinds: [0, 1, 2], placeholder: '0-7 · 1-61 · 2-41' },
      { key: 'contest', label: 'Contest number (blank = current)', kind: 'text', placeholder: '2' }],
    render: function (host, p, ctx) {
      if (!p.id) { host.innerHTML = ''; host.appendChild(H.stateBlock('info', 'Configure this card with a guild, player or planet id.')); return; }
      loading(host, 'Reading ' + p.id);
      var kind = T.kindOf(p.id);
      return resolve(p).then(function (r) {
        var c = r.contest;
        if (kind === 0) return ipGuild(host, p, ctx, c);
        if (kind === 1) return ipPlayer(host, p, ctx, c);
        if (kind === 2) return ipPlanet(host, p, ctx, c);
        throw new Error(p.id + ' is not a guild, player or planet');
      }).catch(function (e) { failed(host, /404/.test(String(e)) ? new Error(p.id + ' has no score in this contest') : e); });
    },
  });
  function ipGuild(host, p, ctx, c) {
    var cid = c.contest_id, gid = p.id;
    return Promise.all([
      api('contests/' + cid + '/guilds/' + gid), guildBook(cid), standings(cid),
      api('contests/' + cid + '/players', { guild_id: gid, limit: 100, include_total: 1, scored_only: 1 }),
    ]).then(function (res) {
      var g = res[0].data, book = res[1], mx = matrix(res[2].data, scoringSectors(c)), mem = res[3];
      host.innerHTML = '';
      var wrap = H.el('div', 'ipc');
      var row = book.byId[gid] || {}, pr = row.profile || {};
      T.retitleGuild(ctx, 'IP ', gid, pr.name || null);
      wrap.appendChild(window.StructsGuildCard.row({
        id: gid, name: pr.name, tag: pr.tag, logo: pr.logo, prefix: row.rank ? '#' + row.rank : null,
        readings: [{ value: fmt(g.overall_points), icon: IP_ICON, title: 'Influence points, all sectors' }],
      }, { actions: [{ icon: 'icon-guild', title: 'Guild', onClick: function () { openGuild(gid); } }] }));
      var ahead = book.rows.filter(function (r) { return num(r.rank) < num(row.rank); }).slice(-1)[0];
      var behind = book.rows.filter(function (r) { return num(r.rank) > num(row.rank); })[0];
      var members = mem.data || [];
      var complete = !mem.total || num(mem.total) <= members.length;
      var rep = repeatWins(g.unique_planets, members);
      wrap.appendChild(tiles([
        ['Sectors held', fmt(row.sectors_controlled)],
        ['Unique', fmt(g.unique_planets)],
        ['Claims', fmt(g.held_planets)],
        ahead ? ['To #' + ahead.rank, fmt(num(ahead.overall_points) - num(g.overall_points))] : behind ? ['Lead over #' + behind.rank, '+' + fmt(num(g.overall_points) - num(behind.overall_points))] : null,
        complete && rep.member_wins ? ['Repeat wins', fmt(rep.repeat) + ' · ' + Math.round(rep.share * 100) + '%', rep.repeat ? 'sui-text-warning' : null, 'Member wins on planets the guild was already credited for'] : null,
      ]));
      var uPts = num(g.unique_planets) * num(c.win_points), cPts = num(g.held_planets) * num(c.claim_points);
      if (uPts + cPts > 0) {
        var bar = H.el('div', 'ipc-split');
        var a = H.el('div', 'ipc-split-u'); a.style.flexGrow = String(uPts); bar.appendChild(a);
        var b = H.el('div', 'ipc-split-c'); b.style.flexGrow = String(cPts); bar.appendChild(b);
        bar.title = fmt(uPts) + ' from unique planets · ' + fmt(cPts) + ' from claims held';
        wrap.appendChild(bar);
        var lab = H.el('div', 'ipc-row-line sui-text-hint');
        lab.appendChild(H.el('span', null, 'Unique ' + fmt(uPts)));
        lab.appendChild(H.el('span', null, 'Claims ' + fmt(cPts) + ' · lost if taken'));
        wrap.appendChild(lab);
      }
      section(wrap, 'By sector');
      var t = H.el('table', 'ipc-table');
      var hr = H.el('tr');
      ['Sector', 'Points', 'Rank', 'Unique', 'Claims', ''].forEach(function (x, i) { hr.appendChild(H.el('th', 'sui-text-header' + (i ? '' : ' ipc-l'), x)); });
      var thd = H.el('thead'); thd.appendChild(hr); t.appendChild(thd);
      var tb = H.el('tbody');
      (g.sectors || []).forEach(function (s) {
        var sec = Number(s.sector);
        var tr = H.el('tr');
        var nm = H.el('td', 'ipc-l'); var l = light(sec); if (l) nm.appendChild(l); nm.appendChild(document.createTextNode(sectorLabel(sec, c.scoring_mode)));
        tr.appendChild(nm);
        tr.appendChild(H.el('td', null, fmt(s.points)));
        tr.appendChild(H.el('td', null, s.sector_rank ? '#' + s.sector_rank : '—'));
        tr.appendChild(H.el('td', null, fmt(s.unique_planets)));
        tr.appendChild(H.el('td', null, fmt(s.held_planets)));
        var lead = mx.leaders[sec] || [];
        var note = !num(s.points) ? '' : lead.indexOf(gid) >= 0 ? (lead.length > 1 ? 'Tied lead' : 'Controls') : '−' + fmt((mx.top[sec] || 0) - num(s.points));
        tr.appendChild(H.el('td', lead.indexOf(gid) >= 0 ? 'sui-text-warning' : 'sui-text-hint', note));
        tb.appendChild(tr);
      });
      t.appendChild(tb);
      wrap.appendChild(t);
      section(wrap, 'Members · personal points', complete ? 'not additive to the guild' : members.length + ' of ' + fmt(mem.total));
      members.forEach(function (m) {
        var mp = m.profile || {};
        wrap.appendChild(window.StructsPlayerCard.row({
          id: m.player_id, name: mp.username || m.player_id, pfp: mp.pfp_client_render_attributes, prefix: '#' + m.rank,
          readings: [{ value: fmt(m.points), icon: IP_ICON, title: 'Personal influence points' },
            { value: fmt(m.unique_planets) + 'u · ' + fmt(m.held_planets) + 'c' }],
        }, { onClick: function () { openIP(m.player_id); },
          actions: [{ icon: 'icon-member', title: 'Player', onClick: function () { openPlayer(m.player_id); } },
            mp.planet_id ? { icon: 'icon-planet', title: 'Planet on the map', onClick: function () { watchPlanet(mp.planet_id); } } : null] }));
      });
      if (!members.length) wrap.appendChild(H.el('div', 'sui-text-hint', 'No member has scored'));
      wrap.appendChild(doorRow([
        { label: 'Race', onClick: function () { add('race', {}); } },
        { label: 'Members on the board', onClick: function () { add('leaders', { kind: 'players', guild: gid }); } },
      ]));
      foot(wrap, c, res[0].meta);
      host.appendChild(wrap);
    });
  }
  function ipPlayer(host, p, ctx, c) {
    var cid = c.contest_id, pid = p.id;
    var start = num(c.start_height), end = Math.min(num(c.projected_height), num(c.end_height));
    var hist = end >= start
      ? api('contests/' + cid + '/players/' + pid + '/history', { start_height: Math.max(start, end - 999999), end_height: end, bucket_blocks: bucketFor(end - start + 1, 60) }).catch(function () { return null; })
      : Promise.resolve(null);
    return Promise.all([api('contests/' + cid + '/players/' + pid), guildBook(cid), hist]).then(function (res) {
      var d = res[0].data, book = res[1], h = res[2];
      var rank = num(d.rank);
      // The board around them: who is just ahead, and their own profile row.
      var near = rank ? api('contests/' + cid + '/players', { limit: Math.min(200, rank + 5), scored_only: 1 }).catch(function () { return null; }) : Promise.resolve(null);
      return near.then(function (nb) {
        var rows = (nb && nb.data) || [];
        var own = rows.filter(function (r) { return r.player_id === pid; })[0];
        var ahead = rows.filter(function (r) { return num(r.points) > num(d.overall_points); }).slice(-1)[0];
        var pr = (own && own.profile) || {};
        host.innerHTML = '';
        var wrap = H.el('div', 'ipc');
        T.retitlePlayer(ctx, 'IP ', pid, pr.username || null);
        wrap.appendChild(window.StructsPlayerCard.row({
          id: pid, name: pr.username || pid, pfp: pr.pfp_client_render_attributes, prefix: rank ? '#' + rank : null,
          guild: d.guild_id ? guildName(book, d.guild_id) : 'No guild', badge: targetBadge(own && own.profile),
          readings: [{ value: fmt(d.overall_points), icon: IP_ICON, title: 'Personal influence points' }],
        }, { actions: [{ icon: 'icon-member', title: 'Player', onClick: function () { openPlayer(pid); } },
          pr.planet_id ? { icon: 'icon-planet', title: 'Planet on the map', onClick: function () { watchPlanet(pr.planet_id); } } : null,
          d.guild_id ? { icon: 'icon-guild', title: 'Guild influence', onClick: function () { openIP(d.guild_id); } } : null] }));
        var series = h && h.data ? seriesOf(h.data, function () { return 'me'; }, Math.max(start, end - 999999)).me || [] : [];
        var paceWin = Math.min(10000, Math.max(1000, Math.round((end - start) / 5)));
        var gap = ahead ? num(ahead.points) - num(d.overall_points) : null;
        wrap.appendChild(tiles([
          ['Unique wins', fmt(d.unique_planets)],
          ['Claims held', fmt(d.held_planets)],
          series.length > 1 ? ['Pace /1k blocks', '+' + H.fmtInt(Math.round(paceOf(series, paceWin)))] : null,
          ahead ? ['To #' + ahead.rank, fmt(gap) + ' · ' + Math.ceil(gap / Math.max(1, num(c.win_points))) + ' wins'] : rank === 1 ? ['Standing', 'First'] : null,
        ]));
        if (series.length > 1) wrap.appendChild(sparkline(series, start, end));
        section(wrap, 'By sector');
        var t = H.el('table', 'ipc-table');
        var hr = H.el('tr');
        ['Sector', 'Points', 'Unique', 'Claims'].forEach(function (x, i) { hr.appendChild(H.el('th', 'sui-text-header' + (i ? '' : ' ipc-l'), x)); });
        var thd = H.el('thead'); thd.appendChild(hr); t.appendChild(thd);
        var tb = H.el('tbody');
        (d.sectors || []).forEach(function (s) {
          var tr = H.el('tr', num(s.points) ? '' : 'ipc-dim');
          var nm = H.el('td', 'ipc-l'); var l = light(s.sector); if (l) nm.appendChild(l); nm.appendChild(document.createTextNode(sectorLabel(s.sector, c.scoring_mode)));
          tr.appendChild(nm);
          tr.appendChild(H.el('td', null, fmt(s.points)));
          tr.appendChild(H.el('td', null, fmt(s.unique_planets)));
          tr.appendChild(H.el('td', null, fmt(s.held_planets)));
          tb.appendChild(tr);
        });
        t.appendChild(tb);
        wrap.appendChild(t);
        var moves = series.filter(function (pt) { return pt.d || pt.du || pt.dc; }).slice(-5).reverse();
        if (moves.length) {
          section(wrap, 'Latest scoring');
          moves.forEach(function (m) {
            var row = H.el('div', 'ipc-srow ipc-thin');
            var bits = [];
            if (m.du) bits.push(signed(m.du) + ' unique');
            if (m.dc) bits.push(signed(m.dc) + ' claim' + (Math.abs(m.dc) === 1 ? '' : 's'));
            row.appendChild(H.el('span', 'ipc-grow', bits.join(' · ') || 'points moved'));
            row.appendChild(H.el('span', m.d < 0 ? 'sui-text-destructive' : 'sui-text-primary', signed(m.d)));
            row.appendChild(H.el('span', 'sui-text-hint ipc-when', fmt(m.from) + '–' + fmt(m.h)));
            wrap.appendChild(row);
          });
        }
        foot(wrap, c, res[0].meta, 'personal · not additive to the guild');
        host.appendChild(wrap);
      });
    });
  }
  function sparkline(series, start, end) {
    var w = 320, hgt = 64;
    var max = Math.max(1, Math.max.apply(null, series.map(function (p) { return p.v; })));
    var X = function (h) { return (w - 2) * (h - start) / Math.max(1, end - start) + 1; };
    var Y = function (v) { return hgt - 2 - (hgt - 4) * v / max; };
    var d = '';
    series.forEach(function (pt, i) { d += i ? ' H' + X(pt.h).toFixed(1) + ' V' + Y(pt.v).toFixed(1) : 'M' + X(Math.max(start, pt.h)).toFixed(1) + ' ' + Y(pt.v).toFixed(1); });
    var s = svg('svg', { viewBox: '0 0 ' + w + ' ' + hgt, preserveAspectRatio: 'none', role: 'img', 'aria-label': 'Points over the contest' }, 'ipc-spark');
    s.appendChild(svg('path', { d: d }, 'ipc-line ipc-c0'));
    return s;
  }
  function ipPlanet(host, p, ctx, c) {
    var cid = c.contest_id;
    return Promise.all([
      invoke('terminal_influence_planet', { contest: Number(cid), planet: p.id }), guildBook(cid), mine(cid),
    ]).then(function (res) {
      var d = res[0], book = res[1], me = res[2], ch = d.chain || {};
      var i2 = d.data && d.data.exists ? d.data : null;
      host.innerHTML = '';
      var wrap = H.el('div', 'ipc');
      var head = H.el('div', 'ipc-row-line');
      var l = light(ch.sector != null ? ch.sector : i2 && i2.sector); if (l) head.appendChild(l);
      head.appendChild(H.el('span', 'sui-text-label ipc-grow', (ch.name ? ch.name + ' · ' : '') + p.id));
      head.appendChild(H.el('span', 'sui-text-hint', sectorLabel(ch.sector != null ? ch.sector : (i2 && i2.sector) || 0, c.scoring_mode)));
      wrap.appendChild(head);
      drawPlanetFacts(wrap, c, book, me && me.guild_id, i2, p.id, ch.owner, ch.owner_guild_id, false);
      // What a win here is worth to each guild near the top, and to us.
      var ids = book.rows.slice(0, 6).map(function (r) { return r.guild_id; });
      if (me && me.guild_id && ids.indexOf(me.guild_id) < 0) ids.push(me.guild_id);
      if (ids.length) {
        section(wrap, 'A win here now is worth');
        var t = H.el('table', 'ipc-table');
        var hr = H.el('tr');
        ['Guild', 'Unique', 'Claim', 'Total'].forEach(function (x, i) { hr.appendChild(H.el('th', 'sui-text-header' + (i ? '' : ' ipc-l'), x)); });
        var thd = H.el('thead'); thd.appendChild(hr); t.appendChild(thd);
        var tb = H.el('tbody');
        ids.forEach(function (g) {
          var w = worthFor(i2 || { guild_coverage: [] }, g, c.win_points, c.claim_points, ch.owner_guild_id);
          var tr = H.el('tr', g === (me && me.guild_id) ? 'ipc-mine' : '');
          var nm = H.el('td', 'ipc-l'); nm.appendChild(swatch(rankCls(book, g))); nm.appendChild(document.createTextNode(guildTag(book, g)));
          tr.appendChild(nm);
          if (w.own) { tr.appendChild(H.el('td', 'sui-text-hint', 'owner')); tr.appendChild(H.el('td')); tr.appendChild(H.el('td', 'sui-text-hint', '—')); }
          else {
            tr.appendChild(H.el('td', w.unique ? null : 'sui-text-hint', w.unique ? '+' + fmt(w.unique) : 'credited'));
            tr.appendChild(H.el('td', w.claim ? null : 'sui-text-hint', w.claim ? '+' + fmt(w.claim) : 'holds'));
            tr.appendChild(H.el('td', w.total >= num(c.win_points) + num(c.claim_points) ? 'sui-text-warning' : null, '+' + fmt(w.total)));
          }
          tb.appendChild(tr);
        });
        t.appendChild(tb);
        wrap.appendChild(t);
      }
      if (ch.sector) wrap.appendChild(doorRow([{ label: 'Territory', onClick: function () { add('territory', { sector: String(ch.sector) }); } }]));
      foot(wrap, c, d.meta);
      host.appendChild(wrap);
    });
  }

  // ── LEADERS ─────────────────────────────────────────────────────────────
  var LEAD = {};
  var PAGE = 25;
  T.register('leaders', {
    label: 'Contest leaderboard', describe: function (p) { return 'Leaders · ' + (p && p.kind === 'guilds' ? 'guilds' : 'players') + (p && p.sector ? ' · ' + sectorLabel(p.sector) : ''); },
    cadenceMs: 30000, defaultWidth: 2, argHint: '[guilds|players] [sector]',
    parseArgs: argsParser({ guilds: { kind: 'guilds' }, guild: { kind: 'guilds' }, players: { kind: 'players' }, player: { kind: 'players' } }),
    params: [{ key: 'kind', label: 'Rank', kind: 'choice', options: [{ value: 'players', label: 'Players' }, { value: 'guilds', label: 'Guilds' }] },
      { key: 'sector', label: 'Sector', kind: 'choice', options: SECTOR_OPTS },
      { key: 'guild', label: 'Only members of guild', kind: 'text', placeholder: '0-7' },
      { key: 'contest', label: 'Contest number (blank = current)', kind: 'text', placeholder: '2' }],
    render: function (host, p, ctx) {
      loading(host, 'Reading the leaderboard');
      var st = LEAD[ctx.id] || (LEAD[ctx.id] = { page: 1, key: '' });
      var key = [p.kind, p.sector, p.guild, p.contest].join('|');
      if (st.key !== key) { st.key = key; st.page = 1; }
      var guilds = p.kind === 'guilds';
      return resolve(p).then(function (r) {
        var c = r.contest, cid = c.contest_id;
        var path = 'contests/' + cid + '/' + (guilds ? 'guilds' : 'players') + (st.page > 1 ? '/page/' + st.page : '');
        var q = { limit: PAGE, include_total: 1, scored_only: 1, sector: p.sector || null };
        if (!guilds && /^0-\d+$/.test(p.guild || '')) q.guild_id = p.guild;
        return Promise.all([api(path, q), guildBook(cid), mine(cid)]).then(function (res) {
          drawLeaders(host, p, ctx, st, c, guilds, res[0], res[1], res[2]);
        });
      }).catch(function (e) { failed(host, e); });
    },
    unmount: function (host, p, ctx) { if (ctx) delete LEAD[ctx.id]; },
  });
  function drawLeaders(host, p, ctx, st, c, guilds, env, book, me) {
    host.innerHTML = '';
    var wrap = H.el('div', 'ipc');
    var set = function (patch) { T.setParams(ctx.id, Object.assign({}, p, patch)); };
    var bar = H.el('div', 'ipc-controls');
    bar.appendChild(H.selectBox(guilds ? 'guilds' : 'players', [{ value: 'players', label: 'Players' }, { value: 'guilds', label: 'Guilds' }], function (v) { set({ kind: v }); }));
    bar.appendChild(H.selectBox(p.sector || '', SECTOR_OPTS, function (v) { set({ sector: v }); }));
    if (p.guild) bar.appendChild(link('Members of ' + guildTag(book, p.guild) + ' ✕', function () { set({ guild: '' }); }));
    wrap.appendChild(bar);
    var rows = env.data || [];
    var myGuild = me && me.guild_id, myId = meId();
    if (!rows.length) wrap.appendChild(H.stateBlock('info', 'No ' + (guilds ? 'guild' : 'player') + ' has scored' + (p.sector ? ' in ' + sectorLabel(p.sector) : '')));
    rows.forEach(function (r) {
      var node;
      if (guilds) {
        var pr = r.profile || {};
        node = window.StructsGuildCard.row({
          id: r.guild_id, name: pr.name, tag: pr.tag, logo: pr.logo, prefix: '#' + r.rank,
          readings: [!p.sector ? { value: r.sectors_controlled + ' ctrl' } : null,
            { value: fmt(r.points), icon: IP_ICON, title: 'Influence points' },
            { value: fmt(r.unique_planets) + 'u · ' + fmt(r.held_planets) + 'c' }],
        }, { onClick: function () { openIP(r.guild_id); },
          actions: [{ icon: 'icon-guild', title: 'Guild', onClick: function () { openGuild(r.guild_id); } }] });
        if (r.guild_id === myGuild) node.classList.add('ipc-mine');
      } else {
        var mp = r.profile || {};
        node = window.StructsPlayerCard.row({
          id: r.player_id, name: mp.username || r.player_id, pfp: mp.pfp_client_render_attributes, prefix: '#' + r.rank,
          guild: r.guild_id ? guildName(book, r.guild_id) : null, badge: targetBadge(mp),
          readings: [{ value: fmt(r.points), icon: IP_ICON, title: 'Personal influence points' },
            { value: fmt(r.unique_planets) + 'u · ' + fmt(r.held_planets) + 'c' }],
        }, { onClick: function () { openIP(r.player_id); },
          actions: [{ icon: 'icon-member', title: 'Player', onClick: function () { openPlayer(r.player_id); } },
            mp.planet_id ? { icon: 'icon-planet', title: 'Planet on the map', onClick: function () { watchPlanet(mp.planet_id); } } : null] });
        if (r.player_id === myId) node.classList.add('ipc-mine');
      }
      wrap.appendChild(node);
    });
    var pages = Math.max(1, Math.ceil(num(env.total) / PAGE));
    if (pages > 1) wrap.appendChild(H.pagination(st.page, pages, function (n) { st.page = Math.max(1, Math.min(pages, n)); T.refresh(ctx.id); }));
    foot(wrap, c, env.meta, env.total != null ? fmt(env.total) + ' ranked' : null);
    host.appendChild(wrap);
  }

  // ── HUNT ────────────────────────────────────────────────────────────────
  var HUNT = {};
  T.register('hunt', {
    label: 'Influence targets', describe: function (p) { return 'Hunt' + (p && p.sector ? ' · ' + sectorLabel(p.sector) : ''); },
    cadenceMs: 60000, defaultWidth: 2, argHint: '[sector]', parseArgs: argsParser({ undefeated: { undefeated: '1' } }),
    params: [{ key: 'sector', label: 'Sector', kind: 'choice', options: SECTOR_OPTS },
      { key: 'undefeated', label: 'Planets', kind: 'choice', options: [{ value: '', label: 'Any' }, { value: '1', label: 'Not yet won by us' }] },
      { key: 'contest', label: 'Contest number (blank = current)', kind: 'text', placeholder: '2' }],
    render: function (host, p, ctx) {
      loading(host, 'Searching for targets');
      var st = HUNT[ctx.id] || (HUNT[ctx.id] = { page: 1 });
      return resolve(p).then(function (r) {
        var c = r.contest;
        if (c.status !== 'active') throw new Error('Contest #' + c.contest_id + ' is not live: a raid now scores nothing');
        return Promise.all([
          invoke('terminal_influence_hunt', { contest: Number(c.contest_id), sector: p.sector ? Number(p.sector) : null, rival: true, undefeated: p.undefeated === '1', page: st.page }),
          standings(c.contest_id), guildBook(c.contest_id), mine(c.contest_id),
        ]).then(function (res) { drawHunt(host, p, ctx, st, c, res[0], res[1], res[2], res[3]); });
      }).catch(function (e) { failed(host, e); });
    },
    unmount: function (host, p, ctx) { if (ctx) delete HUNT[ctx.id]; },
  });
  /* Would `gain` points in `sector` change who leads it, for `guild`? */
  function leadEffect(mx, guild, sector, gain) {
    if (!guild || sector == null || !(sector in mx.top) || !gain) return null;
    var leads = mx.leaders[sector];
    var mineNow = (mx.byGuild[guild] && mx.byGuild[guild].cells[sector] || {}).points || 0;
    if (leads.indexOf(guild) >= 0) return leads.length > 1 ? 'Breaks the tie in ' + String(sector).padStart(3, '0') : null;
    var gap = mx.top[sector] - mineNow;
    if (gain > gap) return 'Takes the lead in ' + String(sector).padStart(3, '0');
    if (gain === gap) return 'Ties the lead in ' + String(sector).padStart(3, '0');
    return null;
  }
  function drawHunt(host, p, ctx, st, c, d, stand, book, me) {
    host.innerHTML = '';
    var wrap = H.el('div', 'ipc');
    var set = function (patch) { T.setParams(ctx.id, Object.assign({}, p, patch)); };
    var bar = H.el('div', 'ipc-controls');
    bar.appendChild(H.selectBox(p.sector || '', SECTOR_OPTS, function (v) { st.page = 1; set({ sector: v }); }));
    bar.appendChild(H.checkbox(p.undefeated === '1', 'Not yet won by us', function (on) { st.page = 1; set({ undefeated: on ? '1' : '' }); }));
    wrap.appendChild(bar);
    var mx = matrix(stand.data, scoringSectors(c));
    var myGuild = me && me.guild_id;
    var rows = (d.rows || []).map(function (r) {
      var gain = num(r.influence_points);
      return { r: r, gain: gain, effect: leadEffect(mx, myGuild, r.sector != null ? Number(r.sector) : null, gain) };
    });
    var scoring = rows.filter(function (x) { return x.gain > 0; }).sort(function (a, b) { return b.gain - a.gain || num(b.r.ore) - num(a.r.ore); });
    var zero = rows.length - scoring.length;
    wrap.appendChild(tiles([
      ['Targets', fmt(scoring.length)],
      ['If every raid wins', '+' + fmt(scoring.reduce(function (a, x) { return a + x.gain; }, 0))],
      myGuild ? ['Change a lead', fmt(scoring.filter(function (x) { return x.effect; }).length), 'sui-text-warning', 'Targets whose win would take, tie or break a sector lead'] : null,
    ]));
    if (!myGuild) wrap.appendChild(H.stateBlock('info', 'Gains are for the guild you score for; your first raid puts you on the board'));
    scoring.forEach(function (x) {
      var r = x.r;
      var node = window.StructsPlayerCard.row({
        id: r.id, name: r.username || r.id, pfp: r.pfp_client_render_attributes || r.pfp,
        guild: r.tag ? '[' + r.tag + '] ' + (r.guild_name || '') : r.guild_name, badge: targetBadge(r),
        readings: [{ value: '+' + fmt(x.gain), icon: IP_ICON, title: 'Influence a win here would earn us' },
          { value: H.fmtOre(num(r.ore)), icon: 'sui-icon-alpha-ore', title: 'Ore held' }],
        marks: [r.sector != null ? { value: sectorLabel(r.sector), title: 'The target planet\'s sector' } : null,
          x.effect ? { value: x.effect, title: 'Against the current standings' } : null],
      }, { onClick: function () { if (r.planet_id) openIP(r.planet_id); },
        actions: [r.planet_id ? { icon: 'icon-planet', title: 'Planet on the map', onClick: function () { watchPlanet(r.planet_id); } } : null,
          { icon: 'icon-member', title: 'Player', onClick: function () { openPlayer(r.id); } }] });
      if (x.effect) node.classList.add('ipc-flag');
      wrap.appendChild(node);
    });
    if (!scoring.length) wrap.appendChild(H.stateBlock('info', 'No rival target would score on this page'));
    var nav = [];
    if (st.page > 1) nav.push({ label: 'Previous page', onClick: function () { st.page--; T.refresh(ctx.id); } });
    if ((d.rows || []).length >= 100) nav.push({ label: 'Next page', onClick: function () { st.page++; T.refresh(ctx.id); } });
    if (nav.length) wrap.appendChild(doorRow(nav));
    foot(wrap, c, stand.meta, 'page ' + st.page + (zero ? ' · ' + zero + ' worth nothing hidden' : ''));
    host.appendChild(wrap);
  }

  // ── CLAIMS ──────────────────────────────────────────────────────────────
  //
  // Two sources, newest first. LIVE: planet-level events the app assembled
  // from the influence GRASS stream (mcp/influence_stream.rs) since it
  // started — a raid's win and claim, a member's coverage moving, a sector
  // lead changing hands. EARLIER: the history API's per-guild, per-sector
  // deltas over the last few thousand blocks, below the first live event, so
  // the card is never empty after a restart and never double-counts.
  var TAPE_BLOCKS = 3000, TAPE_BUCKET = 100, TAPE_ROWS = 60;
  var TAPES = {};
  var tapeListening = false;
  /* A live frame refreshes every CLAIMS card showing its contest, at most
   * once every two seconds per card — a busy block lands many planets. */
  function listenTape() {
    if (tapeListening || !window.StructsEvents) return;
    tapeListening = true;
    window.StructsEvents.listen('influence-tape', function (e) {
      var cid = e && e.payload && String(e.payload.contest_id);
      Object.keys(TAPES).forEach(function (id) {
        var st = TAPES[id];
        if (st.contest !== cid || st.soon) return;
        st.soon = setTimeout(function () { st.soon = null; if (TAPES[id]) T.refresh(id); }, 2000);
      });
    });
  }
  T.register('claims', {
    label: 'Claims tape', describe: function (p) { return 'Claims' + (p && p.sector ? ' · ' + sectorLabel(p.sector) : ''); },
    cadenceMs: 30000, argHint: '[sector]', parseArgs: argsParser({ mine: { show: 'mine' }, leads: { show: 'lead' } }),
    params: [{ key: 'sector', label: 'Sector', kind: 'choice', options: SECTOR_OPTS },
      { key: 'show', label: 'Show', kind: 'choice', options: [{ value: '', label: 'Everything' }, { value: 'mine', label: 'Our guild' }, { value: 'lead', label: 'Lead changes' }] },
      { key: 'contest', label: 'Contest number (blank = current)', kind: 'text', placeholder: '2' }],
    render: function (host, p, ctx) {
      loading(host, 'Reading the last ' + fmt(TAPE_BLOCKS) + ' blocks');
      listenTape();
      var st = TAPES[ctx.id] || (TAPES[ctx.id] = { contest: null, soon: null });
      return resolve(p).then(function (r) {
        var c = r.contest;
        st.contest = String(c.contest_id);
        var end = Math.min(num(c.projected_height), num(c.end_height)), start = Math.max(num(c.start_height), end - TAPE_BLOCKS + 1);
        if (!(end >= start)) throw new Error('The contest starts at block ' + fmt(c.start_height));
        var q = { start_height: start, end_height: end, bucket_blocks: TAPE_BUCKET, group_by: 'guild_sector', sector: p.sector || null };
        var read = api('contests/' + c.contest_id + '/history', q).catch(function (e) {
          if (!/ 422 /.test(String(e))) throw e;
          q.bucket_blocks = TAPE_BUCKET * 5;
          return api('contests/' + c.contest_id + '/history', q);
        });
        var live = invoke('terminal_influence_tape', { contest: Number(c.contest_id), limit: 300 }).catch(function () { return null; });
        return Promise.all([read, guildBook(c.contest_id), mine(c.contest_id), live]).then(function (res) {
          drawTape(host, p, ctx, c, res[0], res[1], res[2], start, end, res[3]);
        });
      }).catch(function (e) { failed(host, e); });
    },
    unmount: function (host, p, ctx) { if (ctx && TAPES[ctx.id]) { clearTimeout(TAPES[ctx.id].soon); delete TAPES[ctx.id]; } },
  });
  /* A live event in the tape's row vocabulary: what happened, to whom, and
   * what it moved for each guild. */
  function liveRow(e) {
    var gains = (e.gains || []).map(function (g) { return { guild_id: g.guild_id, points: num(g.points) }; });
    var raid = e.raid || null;
    return {
      live: true, kind: e.kind, h: num(e.height), at: num(e.at_ms), sector: e.sector != null ? Number(e.sector) : null,
      planet_id: e.planet_id || null, raid: raid, gains: gains,
      credited: e.credited, uncredited: e.uncredited || [],
      holder_before: e.holder_before || null, holder_after: e.holder_after || null,
      guild_before: e.holder_guild_before || null, guild_after: e.holder_guild_after || null,
      leaders: e.leaders || null, before: e.before || null, points: num(e.points),
      guilds: [].concat(gains.map(function (g) { return g.guild_id; }), raid ? [raid.attacker_guild, raid.defender_guild] : [], e.leaders || [], e.before || []).filter(Boolean),
    };
  }
  function keepRow(r, show, myGuild) {
    if (show === 'lead') return r.kind === 'lead';
    if (show === 'mine') {
      if (!myGuild) return false;
      if (r.live) return r.guilds.indexOf(myGuild) >= 0;
      return r.guild_id === myGuild || (r.leaders || []).indexOf(myGuild) >= 0 || (r.before || []).indexOf(myGuild) >= 0;
    }
    return true;
  }
  function drawTape(host, p, ctx, c, hist, book, me, start, end, live) {
    host.innerHTML = '';
    var wrap = H.el('div', 'ipc');
    var set = function (patch) { T.setParams(ctx.id, Object.assign({}, p, patch)); };
    wrap.appendChild(H.navStrip([{ key: '', label: 'All' }, { key: 'mine', label: 'Ours' }, { key: 'lead', label: 'Leads' }], p.show || '', function (k) { set({ show: k }); }));
    var myGuild = me && me.guild_id;
    var sectorWanted = p.sector ? Number(p.sector) : null;
    var liveRows = ((live && live.events) || []).map(liveRow).filter(function (r) {
      return (sectorWanted == null || r.sector === sectorWanted) && keepRow(r, p.show, myGuild);
    });
    var state = H.el('div', 'ipc-row-line');
    var isLive = !!(live && live.live);
    state.appendChild(H.badge(isLive ? 'LIVE' : 'HISTORY', isLive ? 'default' : 'warning'));
    var st = (live && live.status) || {};
    state.appendChild(H.el('span', 'sui-text-hint', isLive
      ? 'Planet events as they land' + (num(st.gaps) ? ' · ' + fmt(st.gaps) + ' gaps' : '')
      : live && live.connected ? 'No influence frames heard yet' : 'GRASS not connected · reading history'));
    wrap.appendChild(state);
    liveRows.slice(0, TAPE_ROWS).forEach(function (r) { wrap.appendChild(liveTapeRow(r, c, book, myGuild)); });

    // Earlier: history deltas below the first live event, so nothing counts twice.
    var floor = liveRows.length ? Math.min.apply(null, liveRows.map(function (r) { return r.h; })) : Infinity;
    var rows = tapeRows(hist.data, start).filter(function (r) { return r.h < floor && keepRow(r, p.show, myGuild); }).slice(0, Math.max(0, TAPE_ROWS - liveRows.length));
    if (liveRows.length && rows.length) section(wrap, 'Earlier · by guild');
    if (!rows.length && !liveRows.length) wrap.appendChild(H.stateBlock('info', 'Nothing scored in the last ' + fmt(end - start + 1) + ' blocks'));
    var KIND = { win: ['WIN', 'default'], claim: ['CLAIM', 'warning'], lost: ['LOST', 'destructive'], lead: ['LEAD', 'solid'] };
    rows.forEach(function (r) {
      var row = H.el('a', 'ipc-tape' + ((r.guild_id && r.guild_id === myGuild) || (r.leaders || []).indexOf(myGuild) >= 0 ? ' ipc-mine' : ''));
      row.href = 'javascript:void(0)';
      var k = KIND[r.kind];
      var line = H.el('div', 'ipc-who');
      line.appendChild(H.badge(k[0], k[1]));
      if (r.kind === 'lead') {
        leadersInto(line, r.leaders, book);
        row.addEventListener('click', function () { add('standings', { sector: String(r.sector) }); });
      } else {
        line.appendChild(swatch(rankCls(book, r.guild_id)));
        var bits = [];
        if (r.unique) bits.push(signed(r.unique) + ' unique');
        if (r.claim) bits.push(signed(r.claim) + ' claim' + (Math.abs(r.claim) === 1 ? '' : 's'));
        line.appendChild(H.el('span', 'ipc-grow', guildTag(book, r.guild_id) + ' ' + (bits.join(' · ') || 'points moved')));
        line.appendChild(H.el('span', 'ipc-right ' + (r.points < 0 ? 'sui-text-destructive' : 'sui-text-primary'), signed(r.points)));
        row.addEventListener('click', function () { openIP(r.guild_id); });
      }
      row.appendChild(line);
      var where = sectorLabel(r.sector, c.scoring_mode) + (r.kind === 'lead' && r.before.length ? ' · from ' + r.before.map(function (g) { return guildTag(book, g); }).join(' = ') : '') + ' · ' + blocksAgo(end - r.h);
      var det = H.el('div', 'sui-text-hint', where);
      det.title = r.kind === 'lead' ? 'Block ' + fmt(r.h) : 'Blocks ' + fmt(r.from) + '–' + fmt(r.h);
      row.appendChild(det);
      wrap.appendChild(row);
    });
    foot(wrap, c, hist.meta, isLive ? 'live from block ' + fmt(st.last_height) : 'blocks of ' + fmt(hist.meta && hist.meta.bucket_blocks));
    host.appendChild(wrap);
  }
  function leadersInto(line, leaders, book) {
    leaders.forEach(function (g, i) { if (i) line.appendChild(document.createTextNode(' = ')); line.appendChild(swatch(rankCls(book, g))); line.appendChild(document.createTextNode(guildTag(book, g))); });
    line.appendChild(H.el('span', 'ipc-grow', leaders.length > 1 ? 'tie' : 'leads'));
  }
  /* A player's name, filled in when the lookup lands. */
  function nameSpan(id) {
    var sp = H.el('span', null, id || '—');
    if (id) T.playerName(id).then(function (n) { if (n) sp.textContent = n; });
    return sp;
  }
  function liveTapeRow(r, c, book, myGuild) {
    var KIND = { raid: ['RAID', 'default'], claim: ['CLAIM', 'warning'], transfer: ['MOVE', 'warning'], lead: ['LEAD', 'solid'] };
    var k = KIND[r.kind] || [String(r.kind).toUpperCase(), 'default'];
    var row = H.el('a', 'ipc-tape ipc-live' + (myGuild && r.guilds.indexOf(myGuild) >= 0 ? ' ipc-mine' : ''));
    row.href = 'javascript:void(0)';
    var line = H.el('div', 'ipc-who');
    line.appendChild(H.badge(k[0], k[1]));
    var bits = [];
    if (r.kind === 'lead') {
      leadersInto(line, r.leaders || [], book);
      row.addEventListener('click', function () { add('standings', { sector: String(r.sector) }); });
    } else {
      var what = H.el('span', 'ipc-grow');
      if (r.kind === 'raid' && r.raid) {
        what.appendChild(swatch(rankCls(book, r.raid.attacker_guild)));
        what.appendChild(nameSpan(r.raid.attacker));
        what.appendChild(document.createTextNode(' beat '));
        what.appendChild(nameSpan(r.raid.defender));
      } else if (r.kind === 'claim') {
        what.appendChild(document.createTextNode('Claim → '));
        what.appendChild(r.holder_after ? nameSpan(r.holder_after) : H.el('span', null, 'nobody'));
      } else {
        what.appendChild(document.createTextNode('Coverage moved with a member'));
      }
      line.appendChild(what);
      // What it moved for our guild, else the largest move.
      var mineGain = r.gains.filter(function (g) { return g.guild_id === myGuild; })[0];
      var shown = mineGain || r.gains.slice().sort(function (a, b) { return Math.abs(b.points) - Math.abs(a.points); })[0];
      if (shown) line.appendChild(H.el('span', 'ipc-right ' + (shown.points < 0 ? 'sui-text-destructive' : 'sui-text-primary'), (mineGain ? '' : guildTag(book, shown.guild_id) + ' ') + signed(shown.points)));
      if (r.credited && r.credited.length) bits.push('credits ' + r.credited.map(function (g) { return guildTag(book, g); }).join(', '));
      if (r.credited === null && r.kind === 'raid') bits.push('first seen');
      if (r.uncredited.length) bits.push('uncredits ' + r.uncredited.map(function (g) { return guildTag(book, g); }).join(', '));
      if (r.guild_before !== r.guild_after && (r.guild_before || r.guild_after)) bits.push('claim ' + (r.guild_before ? guildTag(book, r.guild_before) : '—') + ' → ' + (r.guild_after ? guildTag(book, r.guild_after) : 'cleared'));
      if (r.planet_id) row.addEventListener('click', function () { openIP(r.planet_id); });
    }
    row.appendChild(line);
    var where = [r.planet_id, r.sector != null ? sectorLabel(r.sector, c.scoring_mode) : null].concat(bits)
      .concat(r.kind === 'lead' && r.before && r.before.length ? ['from ' + r.before.map(function (g) { return guildTag(book, g); }).join(' = ')] : [])
      .concat([r.at ? H.ago(r.at) + ' ago' : null]).filter(Boolean).join(' · ');
    var det = H.el('div', 'sui-text-hint', where);
    det.title = 'Block ' + fmt(r.h);
    row.appendChild(det);
    return row;
  }

  T.contest = {
    SECTORS: SECTORS, pickContest: pickContest, matrix: matrix, pathToLead: pathToLead, worthFor: worthFor,
    repeatWins: repeatWins, bucketFor: bucketFor, seriesOf: seriesOf, paceOf: paceOf, leadTimeline: leadTimeline,
    tapeRows: tapeRows, liveRow: liveRow, keepRow: keepRow, errText: errText, sectorLabel: sectorLabel, argsParser: argsParser, leadEffect: leadEffect,
    clearCache: function () { CACHE = {}; },
  };
})();
