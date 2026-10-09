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
 *   StructsSimCard.ladderList(view, opts) who played it, best first ({max, onPerson, compact})
 *   StructsSimCard.verdictGlyph(outcome)  the verdict as the game draws it: icon-success / -subtract / -alert
 *   StructsSimCard.verdictTone(outcome)   …and its colour: sc-ok / sc-tone-warning / sc-bad-text
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
      // The ambit is the game's own sprite, as Team Ops and the Map Viewer label it.
      var amb = el('span', 'chl-amb');
      var ai = el('i', 'sui-icon sui-icon-sm sui-icon-' + ambit);
      ai.title = cap(ambit);
      amb.appendChild(ai);
      band.appendChild(amb);
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
      // Who sent it is the message header right above; the badge says it is yours.
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

  /* One verdict vocabulary for every place a run is drawn — Comms rows, the
   * ladder, the room's event line, the simulator's own panel and debrief: the
   * game's battle-verdict glyphs (victory icon-success, defeat icon-alert)
   * and the catalogue's tones. A defeat is never a tick and never the close X. */
  function verdictGlyph(o) { return o && o.winner === 'player' ? 'icon-success' : o && o.winner === 'draw' ? 'icon-subtract' : 'icon-alert'; }
  function verdictTone(o) { return o && o.winner === 'player' ? 'sc-ok' : o && o.winner === 'draw' ? 'sc-tone-warning' : 'sc-bad-text'; }
  function verdictReading(e, title) {
    var o = e.outcome || {};
    // A reading without a glyph prints its title as a caption; every verdict has one.
    return { value: o.time, icon: 'sui-icon-md ' + verdictGlyph(o),
      title: title != null ? title : str(o.verdict) + ' · best · ' + str(e.name), cls: verdictTone(o) };
  }
  /* The kind as a toned glyph, as the catalogue marks a raid or an incident —
   * never the Command Ship art, which is what a fleet row wears. */
  function emblem(glyph, tone) { return C().emblem.glyph(glyph, 'sm', tone); }

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
      emblem: emblem('icon-raid', s === 'beaten' ? 'enemy' : s === 'for-you' ? 'warning' : 'player'),
      // The best run's time, in its verdict's colour: a defeat can lead a
      // ladder nobody has won, and must not wear a tick.
      readings: shown ? [verdictReading(shown)] : [],
    }, { doors: [playDoor(opts, 'Play ' + str(f.name)), moreDoor(opts)], onClick: opts.onOpen });
    node.classList.add('chl-row');
    return node;
  }

  /* A result someone shared: the battle by name, how it went as its badge,
   * the figures as readings. Who shared it is the message header above. */
  function resultRow(view, opts) {
    opts = opts || {};
    var f = frameOf(view), o = f.outcome || {};
    var won = o.winner === 'player', drew = o.winner === 'draw';
    var node = C().row({
      kind: 'challenge-result', id: f.battle, hideId: true, title: f.name || 'Battle',
      badge: { text: o.verdict || 'Result', mod: won ? 'default' : drew ? 'warning' : 'destructive' },
      sub: [sizeText(f), o.blocks != null ? o.blocks + ' blocks' : null].filter(Boolean).join(' · '),
      state: won ? 'live' : drew ? 'warn' : 'bad',
      emblem: emblem(verdictGlyph(o), won ? 'player' : drew ? 'warning' : 'enemy'),
      readings: [
        o.time ? verdictReading({ outcome: o }, str(o.verdict)) : null,
        o.lost != null ? { value: o.lost + '/' + o.fielded, icon: 'sui-icon-md sui-icon-destroyed', title: 'Structs lost of fielded' } : null,
      ],
    }, { doors: [playDoor(opts, 'Play this battle'), moreDoor(opts)], onClick: opts.onOpen });
    // The stripe and the badge carry the outcome; the row is just a row.
    node.classList.add('chl-row');
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
  /* opts: { onAccept, onWatch, onMore }
   * The battle by name, how it stands as its badge, and who plays whom as the
   * raid row draws a two-sided fight: two faces either side of "vs". */
  function inviteRow(view, opts) {
    opts = opts || {};
    var f = frameOf(view), live = (view && view.live) || {}, st = inviteState(view);
    var author = (view && view.author) || null;
    var host = author ? (author.self ? 'You' : str(author.name)) : '';
    var guest = live.guest_name || null;
    var sub = '';
    if (st === 'ended' && !live.winner_name) sub = 'a draw';
    else if (st === 'waiting') sub = f.to && f.to.length ? 'sent' : 'anyone may take it';
    var v = el('div', 'sc-versus-row');
    var H = author && author.player_id ? C().person({ id: author.player_id, name: author.name, pfp: author.pfp_attrs }) : null;
    // Without the chain's id a player is a name, set as a name is set.
    v.appendChild(H || el('span', 'pc-id sui-text-label', host || '…'));
    v.appendChild(el('span', 'sui-text-label sc-vs', 'vs'));
    var G = live.guest_id ? C().person({ id: live.guest_id, name: live.guest_name, pfp: live.guest_pfp }) : null;
    v.appendChild(G || el('span', 'pc-id sui-text-label', guest || (st === 'for-you' ? 'You' : st === 'waiting' && !(f.to || []).length ? 'anyone' : (f.to && f.to[0] && f.to[0].name) || '…')));
    var doors = [];
    if ((st === 'for-you' || st === 'open') && opts.onAccept) doors.push({ icon: 'icon-raid', title: 'Accept', onClick: function (ev, n) { opts.onAccept(ev, n); } });
    if ((st === 'live' || st === 'lobby') && opts.onWatch) doors.push({ icon: 'icon-raid', title: 'Watch', onClick: function (ev, n) { opts.onWatch(ev, n); } });
    doors.push(moreDoor(opts));
    var node = C().row({
      kind: 'challenge-invite', id: f.battle, hideId: true, title: f.name || 'Battle',
      badge: INVITE[st].badge, sub: sub, state: INVITE[st].stripe, line3: v,
      emblem: emblem('icon-raid', st === 'live' ? 'enemy' : (st === 'for-you' || st === 'waiting') ? 'warning' : 'hint'),
      readings: [f.block_ms ? { value: (f.block_ms / 1000) + ' s', icon: 'sui-icon-md icon-in-progress', title: 'Block time' } : null],
      marks: st === 'ended' ? [{ icon: 'sui-icon sui-icon-md ' + (live.winner_name ? 'icon-success' : 'icon-subtract'),
        value: live.winner_name || null, title: live.winner_name ? 'Won' : 'A draw' }] : null,
    }, { doors: doors });
    node.classList.add('chl-row', 'chl-invite');
    if (st === 'lapsed' || st === 'cancelled') node.classList.add('chl-faded');
    return node;
  }

  /* Who played, best first: rank, face and name, then the run as readings —
   * its time behind the verdict glyph, and what it lost. opts: { max,
   * onPerson, compact } — compact leaves the losses out (a narrow panel). */
  function ladderList(view, opts) {
    opts = opts || {};
    var lad = ladderOf(view);
    if (!lad.length) return null;
    var me = view && view.me;
    var box = el('div', 'chl-ladder');
    lad.slice(0, opts.max || 5).forEach(function (e) {
      var o = e.outcome || {};
      var line = el('div', 'chl-run' + (e.sender === me ? ' chl-me' : '') + (o.current ? '' : ' chl-old'));
      line.appendChild(el('span', 'chl-rank sui-text-label sui-text-hint', str(e.rank)));
      var who = e.player_id ? C().person({ id: e.player_id, name: e.name, pfp: e.pfp_attrs },
        opts.onPerson ? { onClick: function (ev) { opts.onPerson(e, ev); } } : null) : el('span', 'pc-nm', str(e.name));
      line.appendChild(who);
      var vr = verdictReading(e, str(o.verdict));
      line.appendChild(C().readings([vr,
        opts.compact ? null : { value: str(o.lost), icon: 'sui-icon-md sui-icon-destroyed', title: 'Structs lost' }]));
      if (!o.current) line.title = 'Played on older rules (r' + str(o.revision) + ')';
      box.appendChild(line);
    });
    if (lad.length > (opts.max || 5)) box.appendChild(el('div', 'chl-more sui-text-hint', '+' + (lad.length - (opts.max || 5)) + ' more'));
    return box;
  }

  /* The tallies are the player card's record rack. Best wears its run's
   * verdict colour: a defeat can lead a ladder nobody has won. */
  function stats(view) {
    var lad = ladderOf(view), top = first(view);
    var won = lad.filter(function (e) { return e.outcome && e.outcome.winner === 'player'; }).length;
    var rack = P().record([
      { value: lad.length, label: 'Played' },
      { value: won, label: 'Won' },
      { value: top ? top.outcome.time : null, label: 'Best', title: top ? str(top.outcome.verdict) + ' · ' + str(top.name) : null },
    ]);
    rack.classList.add('chl-stats');
    var best = rack.children[2] && rack.children[2].querySelector('.pc-rec-v');
    if (top && best) best.classList.add(verdictTone(top.outcome));
    return rack;
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
      // Comms' own pointer to a thread. The type class sits on the inner
      // span: the window's `a` rule outranks a class on the anchor itself.
      var last = view.replies && view.replies[view.replies.length - 1];
      var th = el(opts.onReplies ? 'a' : 'div', 'chat-reply-quote chat-mod-thread chl-thread');
      if (opts.onReplies) {
        th.href = 'javascript:void(0)';
        th.addEventListener('click', function (ev) { ev.stopPropagation(); opts.onReplies(ev); });
      }
      if (last) {
        th.appendChild(el('span', 'chat-reply-who', str(last.name)));
        th.appendChild(el('span', 'chat-reply-text chl-said', str(last.body)));
      }
      th.appendChild(el('span', 'chl-replies sui-text-label sui-text-primary', replies + (replies === 1 ? ' reply' : ' replies')));
      extra.push(th);
    }
    if (opts.onPlay) {
      // The one verb, last in the body and across it, as the game's planet
      // card ends with its buttons.
      var play = el('a', 'sui-screen-btn sui-mod-primary chl-play');
      play.href = 'javascript:void(0)';
      play.appendChild(el('i', 'sui-icon sui-icon-md icon-raid'));
      play.appendChild(el('span', null, 'Play'));
      play.addEventListener('click', function (ev) { ev.stopPropagation(); opts.onPlay(ev, play); });
      var cta = el('div', 'sui-screen-btn-flex-wrapper chl-cta');
      cta.appendChild(play);
      extra.push(cta);
    }
    // Block time is a setting: a quiet mark beside the doors, as the player
    // card's foot carries its marks.
    var foot = null;
    if (f.block_ms) {
      foot = el('div', 'pc-marks sc-marks');
      var bt = el('span', 'pc-mark');
      bt.title = 'Block time';
      bt.appendChild(el('i', 'sui-icon sui-icon-md icon-in-progress'));
      bt.appendChild(document.createTextNode(' ' + (f.block_ms / 1000) + ' s'));
      foot.appendChild(bt);
    }
    var node = C().card({
      kind: 'challenge', id: f.battle, hideId: true, title: f.name || 'Battle', headIcon: 'icon-raid',
      sub: sizeText(f),
      badge: BADGE[s] || difficultyBadge(f), state: STRIPE[s],
      readings: [], extra: extra, foot: foot,
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

  root.StructsSimCard = { row: row, card: card, resultRow: resultRow, inviteRow: inviteRow, inviteState: inviteState, board: board, state: state,
    ladderList: ladderList, subText: subText, verdictGlyph: verdictGlyph, verdictTone: verdictTone };
})(typeof window !== 'undefined' ? window : globalThis);
