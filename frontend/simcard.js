/* A simulator battle named in chat — the challenge card.
 *
 * The same family as everything else Comms unfurls (structs-cards.js): a
 * ROW by default, one verb (Play) and a "more" menu, opening in place to the
 * planet-card frame. What is its own here: the battle in miniature (both
 * fleets, band by band, from the code itself), and the ladder — who played
 * it in this room and how it went, best first.
 *
 *   StructsSimCard.row(view, opts)        the default unfurl
 *   StructsSimCard.card(view, opts)       opened
 *   StructsSimCard.resultRow(view, opts)  a shared result, verdict first
 *   StructsSimCard.inviteRow(view, opts)  a live battle: Accept, Watch, or how it went
 *   StructsSimCard.board(code)            the miniature, or null
 *   StructsSimCard.state(view)            'open' | 'played' | 'for-you' | 'best' | 'beaten'
 *
 * `view` is what Rust's matrix_sim_thread answers ({frame, ladder, author,
 * replies, me, …}); before that arrives it is just {frame}, and every part
 * draws from what it has. `frame` is the message's own `sim`, parsed and
 * decoded by matrix/sim.rs. Descriptors are text; everything is textContent.
 *
 * Needs playercard.js + structs-cards.js; the miniature also needs
 * simcode.js, simulator-types.js and battle-art.js, and is left out without.
 */
(function (root) {
  'use strict';

  function C() { return root.StructsCards; }
  function P() { return root.StructsPlayerCard.parts; }
  function el(tag, cls, text) { return P().el(tag, cls, text); }
  function str(v) { return v == null ? '' : String(v); }
  function cap(s) { s = str(s); return s.charAt(0).toUpperCase() + s.slice(1); }

  var AMBITS = ['space', 'air', 'land', 'water'];

  // ── the battle in miniature ───────────────────────────────────────────
  function typesById() {
    var T = root.SimulatorTypes, out = {};
    if (T && T.types) T.types.forEach(function (t) { out[t.id] = t; });
    return out;
  }
  function slug(name) { return str(name).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, ''); }
  function artSrc(type) {
    var A = root.BattleArt;
    var a = A && type && A.ART[slug(type.type)];
    return a ? A.artPath(a.dir, 'struct-base') : null;
  }

  /* Band by band, as the simulator lays it out: your command ship's column,
   * your four slots, the ambit, theirs, their command ship. Defenders carry
   * the game's own defending mark. */
  function board(code) {
    var Code = root.StructsSimCode;
    var c = Code && Code.decode(code);
    if (!c) return null;
    var types = typesById();
    var guards = {};
    c.units.forEach(function (u) { if (u.protects) guards[u.id] = true; });
    var at = {};
    c.units.forEach(function (u) { at[u.side + '|' + u.ambit + '|' + (types[u.type] && types[u.type].type === 'Command Ship' ? 'cmd' : u.slot)] = u; });
    var box = el('div', 'chl-board');
    box.setAttribute('role', 'img');
    box.setAttribute('aria-label', 'Both fleets');
    AMBITS.forEach(function (ambit) {
      var band = el('div', 'chl-band chl-' + ambit);
      function cell(side, key) {
        var u = at[side + '|' + ambit + '|' + key];
        var c2 = el('span', 'chl-cell chl-' + side + (u ? ' chl-full' : ''));
        if (u) {
          var t = types[u.type];
          c2.title = (t ? t.type : 'Struct') + (side === 'player' ? '' : ' · computer');
          var src = artSrc(t);
          if (src) { var im = el('img', 'chl-art'); im.alt = ''; im.src = src; c2.appendChild(im); }
          if (guards[u.id]) c2.appendChild(el('i', 'sui-icon sui-icon-sm sui-icon-defending chl-guard'));
        }
        return c2;
      }
      band.appendChild(cell('player', 'cmd'));
      [0, 1, 2, 3].forEach(function (s) { band.appendChild(cell('player', s)); });
      band.appendChild(el('span', 'chl-amb sui-text-label', ambit.charAt(0).toUpperCase()));
      [0, 1, 2, 3].forEach(function (s) { band.appendChild(cell('computer', s)); });
      band.appendChild(cell('computer', 'cmd'));
      box.appendChild(band);
    });
    return box;
  }

  // ── what a view says ──────────────────────────────────────────────────
  function frameOf(view) { return (view && view.frame) || {}; }
  function ladderOf(view) { return (view && view.ladder) || []; }
  function mine(view) {
    var me = view && view.me;
    return ladderOf(view).filter(function (e) { return me && e.sender === me; })[0] || null;
  }
  function first(view) {
    return ladderOf(view).filter(function (e) { return e.outcome && e.outcome.current; })[0] || null;
  }
  function addressedToMe(view) {
    var f = frameOf(view), me = view && view.me;
    return !!(me && f.to && f.to.indexOf(me) !== -1 && !(view.author && view.author.self));
  }
  /* One word for the row's stripe and badge, in the order a reader cares. */
  function state(view) {
    var m = mine(view), top = first(view);
    if (m && top && top.sender === m.sender) return 'best';
    if (m && view.beaten) return 'beaten';
    if (addressedToMe(view) && !m) return 'for-you';
    return ladderOf(view).length ? 'played' : 'open';
  }
  var BADGE = {
    'for-you': { text: 'For you', mod: 'warning' },
    best: { text: 'Your best', mod: 'solid' },
    beaten: { text: 'Beaten', mod: 'destructive' },
  };
  var STRIPE = { open: 'live', played: 'live', 'for-you': 'warn', best: 'live', beaten: 'bad' };
  function difficultyBadge(f) {
    return { text: cap(f.difficulty || ''), mod: f.difficulty === 'hard' ? 'warning' : 'default' };
  }
  function sizeText(f) { return f.units ? f.units[0] + ' v ' + f.units[1] : ''; }

  /* "9 v 9 · 4 played · best T.Xue", or who it is from / what to beat. */
  function subText(view) {
    var f = frameOf(view), s = state(view), lad = ladderOf(view), top = first(view), m = mine(view);
    var bits = [sizeText(f)];
    if (s === 'for-you') {
      bits = ['from ' + str(view.author && view.author.name)];
      if (f.outcome) bits.push('to beat ' + f.outcome.time);
    } else if (s === 'best') {
      bits.push('1st of ' + lad.length);
    } else if (s === 'beaten' && top && m) {
      bits = [str(top.name) + ' ' + top.outcome.time, 'you ' + m.outcome.time];
    } else if (lad.length) {
      bits.push(lad.length + ' played');
      if (top) bits.push('best ' + str(top.name));
    } else {
      bits.push(f.outcome ? 'to beat ' + f.outcome.time : 'unplayed');
    }
    return bits.filter(Boolean).join(' · ');
  }

  function emblem() { return C().emblem.art('Command Ship', 'sm'); }
  /* One verdict vocabulary for every place a run is drawn — Comms rows, the
   * ladder, the room's event line and the simulator's own panel. */
  function verdictGlyph(o) { return o && o.winner === 'player' ? 'icon-success' : o && o.winner === 'draw' ? 'icon-subtract' : 'icon-alert'; }
  function verdictTone(o) { return o && o.winner === 'player' ? 'sc-ok' : o && o.winner === 'draw' ? 'sc-tone-warning' : 'sc-bad-text'; }
  function verdictReading(e) {
    var o = e.outcome || {};
    var won = o.winner === 'player';
    // A reading without a glyph prints its title as a caption; every verdict has one.
    var glyph = won ? 'icon-success' : o.winner === 'draw' ? 'icon-subtract' : 'icon-close';
    return { value: o.time, icon: 'sui-icon-md ' + glyph, title: str(o.verdict) + ' · best · ' + str(e.name),
      cls: won ? 'sc-ok' : o.winner === 'draw' ? 'sc-tone-warning' : 'sc-bad-text' };
  }

  function playDoor(opts, title) {
    return opts.onPlay ? { icon: 'icon-raid', title: title || 'Play', onClick: function (ev, node) { opts.onPlay(ev, node); } } : null;
  }
  function moreDoor(opts) {
    return opts.onMore ? { icon: 'icon-menu', title: 'More', onClick: function (ev, node) { opts.onMore(ev, node); } } : null;
  }

  /* The default unfurl. opts: { onPlay, onMore, onOpen } */
  function row(view, opts) {
    opts = opts || {};
    var f = frameOf(view), s = state(view), top = first(view), m = mine(view);
    var shown = s === 'best' && m ? m : top;
    var node = C().row({
      kind: 'challenge', id: f.battle, hideId: true, title: f.name || 'Battle',
      badge: BADGE[s] || difficultyBadge(f),
      sub: subText(view), state: STRIPE[s],
      emblem: emblem(),
      // The best run's time, in its verdict's colour: a defeat can lead a
      // ladder nobody has won, and must not wear a tick.
      readings: shown ? [verdictReading(shown)] : [],
    }, { doors: [playDoor(opts, 'Play ' + str(f.name)), moreDoor(opts)], onClick: opts.onOpen });
    node.classList.add('chl-row');
    return node;
  }

  /* A result someone shared: how it went first, then which battle. */
  function resultRow(view, opts) {
    opts = opts || {};
    var f = frameOf(view), o = f.outcome || {};
    var who = view && view.author && view.author.name;
    var node = C().row({
      kind: 'challenge-result', id: f.battle, hideId: true, title: o.verdict || 'Result',
      badge: { text: f.name || 'Battle', mod: 'default' },
      sub: [o.time, 'lost ' + o.lost + ' of ' + o.fielded, o.blocks + ' blocks', who].filter(Boolean).join(' · '),
      state: o.winner === 'player' ? 'live' : o.winner === 'draw' ? 'warn' : 'bad',
      emblem: emblem(),
      readings: [],
    }, { doors: [playDoor(opts, 'Play this battle'), moreDoor(opts)], onClick: opts.onOpen });
    node.classList.add('chl-row', o.winner === 'player' ? 'chl-won' : o.winner === 'draw' ? 'chl-drew' : 'chl-lost');
    return node;
  }

  /* A live battle's invite: who is playing whom, and how it stands — read
   * from the host's own status frames (view.live), never from the room. */
  var LAPSE_MS = 15 * 60 * 1000;
  function inviteState(view) {
    var f = frameOf(view), live = view && view.live, me = view && view.me;
    if (live && live.state) return live.state;
    if (view && view.author && view.author.self) return 'waiting';
    if (view && view.ts && Date.now() - Number(view.ts) > LAPSE_MS) return 'lapsed';
    if (f.to && f.to.length && f.to.indexOf(me) === -1) return 'theirs';
    return f.to && f.to.length ? 'for-you' : 'open';
  }
  var INVITE = {
    waiting: { badge: { text: 'Waiting', mod: 'warning' }, stripe: 'warn' },
    'for-you': { badge: { text: 'For you', mod: 'warning' }, stripe: 'warn' },
    open: { badge: { text: 'Open', mod: 'default' }, stripe: 'live' },
    theirs: { badge: { text: 'Invited', mod: 'default' }, stripe: null },
    lobby: { badge: { text: 'Lobby', mod: 'default' }, stripe: 'live' },
    live: { badge: { text: 'Live', mod: 'destructive' }, stripe: 'bad' },
    ended: { badge: { text: 'Ended', mod: 'default' }, stripe: null },
    cancelled: { badge: { text: 'Cancelled', mod: 'default' }, stripe: null },
    lapsed: { badge: { text: 'Lapsed', mod: 'default' }, stripe: null },
  };
  /* opts: { onAccept, onWatch, onMore } */
  function inviteRow(view, opts) {
    opts = opts || {};
    var f = frameOf(view), live = (view && view.live) || {}, st = inviteState(view);
    var host = view && view.author ? (view.author.self ? 'You' : str(view.author.name)) : '';
    var guest = live.guest_name || null;
    var sub;
    if (st === 'ended') sub = live.winner_name ? live.winner_name + ' won · ' + host + ' v ' + (guest || '…') : 'a draw · ' + host + ' v ' + (guest || '…');
    else if (st === 'live' || st === 'lobby') sub = host + ' v ' + (guest || '…') + ' · ' + (f.name || 'Battle');
    else if (st === 'waiting') sub = (f.to && f.to.length ? 'sent' : 'anyone may take it') + ' · ' + (f.name || 'Battle') + ' · ' + (f.block_ms / 1000) + ' s';
    else sub = (view && view.author && view.author.self ? '' : 'from ' + host + ' · ') + (f.name || 'Battle') + ' · ' + (f.block_ms / 1000) + ' s';
    var doors = [];
    if ((st === 'for-you' || st === 'open') && opts.onAccept) doors.push({ icon: 'icon-raid', title: 'Accept', onClick: function (ev, n) { opts.onAccept(ev, n); } });
    if ((st === 'live' || st === 'lobby') && opts.onWatch) doors.push({ icon: 'icon-detected', title: 'Watch', onClick: function (ev, n) { opts.onWatch(ev, n); } });
    doors.push(moreDoor(opts));
    var node = C().row({
      kind: 'challenge-invite', id: f.battle, hideId: true, title: 'Live battle',
      badge: INVITE[st].badge, sub: sub, state: INVITE[st].stripe, emblem: emblem(), readings: [],
    }, { doors: doors });
    node.classList.add('chl-row', 'chl-invite');
    if (st === 'lapsed' || st === 'cancelled') node.classList.add('chl-faded');
    return node;
  }

  /* Who played, best first: rank, face, name, verdict, time, lost. */
  function ladderList(view, opts) {
    opts = opts || {};
    var lad = ladderOf(view);
    if (!lad.length) return null;
    var me = view && view.me;
    var box = el('div', 'chl-ladder');
    lad.slice(0, opts.max || 5).forEach(function (e) {
      var o = e.outcome || {};
      var line = el('div', 'chl-run' + (e.sender === me ? ' chl-me' : '') + (o.current ? '' : ' chl-old'));
      line.appendChild(el('span', 'chl-rank sui-text-hint', str(e.rank)));
      var who = e.player_id ? C().person({ id: e.player_id, name: e.name, pfp: e.pfp_attrs },
        opts.onPerson ? { onClick: function (ev) { opts.onPerson(e, ev); } } : null) : el('span', 'pc-nm', str(e.name));
      line.appendChild(who);
      line.appendChild(el('span', 'chl-verdict ' + (o.winner === 'player' ? 'sc-ok' : o.winner === 'draw' ? 'sc-tone-warning' : 'sc-bad-text'), str(o.verdict)));
      line.appendChild(el('span', 'chl-time', str(o.time)));
      // compact: a narrow panel (the simulator's) leaves the losses out.
      if (!opts.compact) line.appendChild(el('span', 'chl-lost sui-text-hint', 'lost ' + str(o.lost)));
      if (!o.current) line.title = 'Played on older rules (r' + str(o.revision) + ')';
      box.appendChild(line);
    });
    if (lad.length > (opts.max || 5)) box.appendChild(el('div', 'chl-more sui-text-hint', '+' + (lad.length - (opts.max || 5)) + ' more'));
    return box;
  }

  function stats(view) {
    var lad = ladderOf(view), top = first(view);
    var won = lad.filter(function (e) { return e.outcome && e.outcome.winner === 'player'; }).length;
    var box = el('div', 'chl-stats');
    [[lad.length, 'Played'], [won, 'Won'], [top ? top.outcome.time : '–', 'Best']].forEach(function (p, i) {
      var cell = el('div', 'chl-stat');
      cell.appendChild(el('div', 'chl-stat-v' + (i === 2 && top ? ' sc-ok' : ''), str(p[0])));
      cell.appendChild(el('div', 'chl-stat-l sui-text-label sui-text-hint', p[1]));
      box.appendChild(cell);
    });
    return box;
  }

  /* Opened. opts: { onPlay, onMore, onCopy, onCollapse, onReplies, onPerson } */
  function card(view, opts) {
    opts = opts || {};
    var f = frameOf(view), s = state(view);
    var extra = [];
    var b = board(f.battle);
    if (b) extra.push(b);
    if (ladderOf(view).length) extra.push(stats(view));
    var lad = ladderList(view, opts);
    if (lad) extra.push(lad);
    var replies = (view && view.reply_count) || 0;
    if (replies) {
      var last = view.replies && view.replies[view.replies.length - 1];
      var th = el('div', 'chl-thread');
      var link = el(opts.onReplies ? 'a' : 'span', 'chl-replies sui-text-label', replies + (replies === 1 ? ' reply' : ' replies'));
      if (opts.onReplies) {
        link.href = 'javascript:void(0)';
        link.addEventListener('click', function (ev) { ev.stopPropagation(); opts.onReplies(ev); });
      }
      th.appendChild(link);
      if (last) {
        var said = el('span', 'chl-said');
        said.appendChild(el('span', 'chl-said-who', str(last.name)));
        said.appendChild(el('span', 'sui-text-hint', ' ' + str(last.body)));
        th.appendChild(said);
      }
      extra.push(th);
    }
    var play = null;
    if (opts.onPlay) {
      play = el('a', 'sui-screen-btn sui-mod-primary chl-play');
      play.href = 'javascript:void(0)';
      play.appendChild(el('i', 'sui-icon sui-icon-md icon-raid'));
      play.appendChild(el('span', null, 'Play'));
      play.addEventListener('click', function (ev) { ev.stopPropagation(); opts.onPlay(ev, play); });
    }
    var who = view && view.author ? [str(view.author.name)] : [];
    var node = C().card({
      kind: 'challenge', id: f.battle, hideId: true, title: f.name || 'Battle',
      sub: who.concat([sizeText(f), (f.block_ms / 1000) + ' s blocks']).filter(Boolean).join(' · '),
      badge: BADGE[s] || difficultyBadge(f), state: STRIPE[s],
      readings: [], extra: extra, foot: play,
    }, {
      doors: [
        opts.onCopy ? { icon: 'icon-copy', title: 'Copy link', onClick: function (ev) { opts.onCopy(ev); } } : null,
        moreDoor(opts),
        opts.onCollapse ? { icon: 'icon-chevron-up', title: 'Collapse', onClick: function (ev) { opts.onCollapse(ev); } } : null,
      ],
    });
    node.classList.add('chl-card');
    return node;
  }

  root.StructsSimCard = { row: row, card: card, resultRow: resultRow, inviteRow: inviteRow, inviteState: inviteState, board: board, state: state, ladderList: ladderList, subText: subText, verdictGlyph: verdictGlyph, verdictTone: verdictTone };
})(typeof window !== 'undefined' ? window : globalThis);
