/* The Terminal card catalogue — every data set the app shows, drawn one way.
 *
 * playercard.js, guildcard.js and providercard.js draw the three things that
 * have faces. This module draws everything else in the same family, on the
 * same parts (`StructsPlayerCard.parts`): planets, fleets, structs,
 * substations, reactors, agreements, guild tokens, proof tasks, transactions,
 * raids, incidents, automation loops, alert rules, wallet assets, tape events
 * and workspaces. Each has the shapes that suit it:
 *
 *   .card(d, opts)   the game's planet-card frame (vertical)
 *   .row(d, opts)    one aligned line for lists (horizontal)
 *   .chip(d, opts)   inline, for a thing named inside something else
 *
 * and the readings they are built from are shared here too: meter,
 * countdown, sparkline, health, progress, versus, emblem.
 *
 * The rules (proposals/terminal-card-catalogue.md): click the body opens,
 * click the emblem is the secondary act, doors are icon actions with titles
 * and destructive ones are red and last, chips PEEK their card in place, rows
 * select, every handle is keyboard-focusable, a 2px stripe carries state.
 * No captions: the glyph is the label, the title is the explanation.
 *
 * Descriptors are plain, pre-formatted strings — this file knows nothing of
 * units or commands. Everything is built with textContent.
 */
(function (root) {
  'use strict';

  function parts() {
    var pc = root.StructsPlayerCard;
    if (!pc || !pc.parts) throw new Error('structs-cards.js needs playercard.js loaded first');
    return pc.parts;
  }
  function str(v) { return v == null ? '' : String(v); }
  function T(t) { return document.createTextNode(t); }
  function el(tag, cls, text) { return parts().el(tag, cls, text); }
  function icon(cls) { return parts().icon(cls); }

  // ── art ───────────────────────────────────────────────────────────────
  // img/structs/<slug>/<slug>-struct-base.png. The slug is the kebab-cased
  // type name except for the abbreviated nine, mirrored from the webapp's
  // StructTypeArtSetBuilder (same table as board-pages.js). A type with no
  // art (Continental Power Plant, World Engine) falls back to a glyph.
  var STRUCT_ART = {
    'command ship': 'cmd-ship', 'ore extractor': 'extractor', 'ore refinery': 'refinery',
    'field generator': 'generator', 'high altitude interceptor': 'interceptor', 'jamming satellite': 'jamming-sat',
    'orbital shield generator': 'orb-shield', 'planetary defense cannon': 'pdc', 'sam launcher': 'sam-launcher',
  };
  function artSlug(name) {
    var k = str(name).toLowerCase();
    return STRUCT_ART[k] || k.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  }

  /* The emblem frame is guildcard.css's `.gc-emblem` (72 / 44 / 24px). */
  function emblemFrame(size, extra) {
    return el('div', 'gc-emblem' + (size ? ' gc-' + size : '') + (extra ? ' ' + extra : ''));
  }
  var emblem = {
    art: function (typeName, size) {
      var box = emblemFrame(size, 'sc-art');
      var slug = artSlug(typeName);
      var im = el('img'); im.alt = '';
      im.src = 'img/structs/' + slug + '/' + slug + '-struct-base.png';
      im.addEventListener('error', function () { if (im.parentNode) box.replaceChild(icon((size === 'xs' ? 'sui-icon-md' : 'sui-icon-lg') + ' icon-deploy'), im); });
      box.appendChild(im);
      return box;
    },
    glyph: function (cls, size, tone) {
      var box = emblemFrame(size);
      var i = icon((size === 'xs' ? 'sui-icon-md ' : 'sui-icon-lg ') + cls);
      if (tone) i.classList.add('sc-tone-' + tone);
      box.appendChild(i);
      return box;
    },
    img: function (src, size) {
      var box = emblemFrame(size, 'sc-art');
      var im = el('img'); im.alt = ''; im.src = str(src);
      im.addEventListener('error', function () { if (im.parentNode) box.replaceChild(icon('sui-icon-lg icon-unknown'), im); });
      box.appendChild(im);
      return box;
    },
  };

  // ── readings ──────────────────────────────────────────────────────────
  function reading(value, iconCls, title, cls) {
    var r = parts().reading({ value: value, icon: iconCls, title: title });
    if (cls) r.classList.add(cls);
    return r;
  }
  function readings(list) {
    var box = el('div', 'pc-reads');
    (list || []).forEach(function (r) {
      if (!r) return;
      box.appendChild(r.nodeType ? r : reading(r.value, r.icon, r.title, r.cls));
    });
    return box;
  }
  /* The game's own 10-chunk bar, floor-rounded like the action bar's. */
  function progress(frac, cls) {
    var wrap = el('div', 'sui-action-bar-progress-bar' + (cls ? ' ' + cls : ''));
    var filled = Math.floor(Math.max(0, Math.min(1, Number(frac) || 0)) * 10);
    for (var i = 0; i < 10; i++) wrap.appendChild(el('div', 'sui-action-bar-progress-bar-chunk' + (i < filled ? ' sui-mod-filled' : '')));
    return wrap;
  }
  /* Health in the health colour; the damage colour under 35%. */
  function health(h, max) {
    var m = Number(max) || 0, v = Number(h) || 0;
    var w = el('span', 'pc-res sc-health' + (m > 0 && v / m < 0.35 ? ' sc-bad' : ''));
    w.title = 'Health ' + v + (m ? ' / ' + m : '');
    w.appendChild(progress(m ? v / m : 0));
    return w;
  }
  /* Load over capacity: a bar with ticks at 80 and 90 percent. */
  function meter(load, cap, fmt, title) {
    var l = Number(load) || 0, c = Number(cap) || 0;
    var frac = c > 0 ? Math.min(1, l / c) : 0;
    var m = el('span', 'pc-res sc-meter' + (frac >= 0.95 ? ' sc-bad' : frac >= 0.8 ? ' sc-warn' : ''));
    m.title = title || ('Load ' + fmt(l) + ' of ' + fmt(c));
    var cap2 = el('span', 'sc-meter-cap');
    cap2.appendChild(el('span', null, fmt(l)));
    cap2.appendChild(el('span', 'pc-id', fmt(c)));
    var bar = el('span', 'sc-meter-bar');
    var fill = el('span', 'sc-meter-fill'); fill.style.width = (frac * 100) + '%'; bar.appendChild(fill);
    [0.8, 0.9].forEach(function (t) { var k = el('span', 'sc-meter-tick'); k.style.left = (t * 100) + '%'; bar.appendChild(k); });
    m.appendChild(cap2); m.appendChild(bar);
    return m;
  }
  /* Time left, with the whole term as the bar; blocks in the title. */
  function countdown(text, frac, title) {
    var r = el('span', 'pc-res sc-count');
    if (title) r.title = title;
    r.appendChild(T(str(text) + ' '));
    r.appendChild(progress(frac));
    return r;
  }
  function sparkline(vals, tone, title) {
    var w = 96, hgt = 24;
    var v = (vals || []).map(Number).filter(isFinite);
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 ' + w + ' ' + hgt);
    svg.setAttribute('class', 'sc-spark' + (tone ? ' sc-tone-' + tone : ''));
    if (title) { var t = document.createElementNS('http://www.w3.org/2000/svg', 'title'); t.textContent = title; svg.appendChild(t); }
    if (v.length > 1) {
      var max = Math.max.apply(null, v), min = Math.min.apply(null, v), rng = (max - min) || 1;
      var pts = v.map(function (x, i) { return (i / (v.length - 1) * w).toFixed(1) + ',' + (hgt - 2 - (x - min) / rng * (hgt - 4)).toFixed(1); }).join(' ');
      var pl = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
      pl.setAttribute('points', pts); pl.setAttribute('fill', 'none'); pl.setAttribute('stroke', 'currentColor'); pl.setAttribute('stroke-width', '2'); pl.setAttribute('shape-rendering', 'crispEdges');
      svg.appendChild(pl);
    }
    return svg;
  }
  /* Attacker over defender, each with the game's own glyph. */
  function versus(attacker, defender, opts) {
    opts = opts || {};
    var box = el('div', 'sc-versus');
    function line(glyph, title, who) {
      var g = icon(glyph); g.title = title; box.appendChild(g);
      var p = who && who.id ? parts().personLine(who, { onClick: opts.onPerson ? function (ev, node) { opts.onPerson(who, ev, node); } : null }) : el('span', 'pc-id', title.toLowerCase() + ' unknown');
      box.appendChild(p);
    }
    line('sui-icon-attacker', 'Attacker', attacker);
    line('sui-icon-defending', 'Defender', defender);
    return box;
  }
  function badge(b) { return b && b.text ? parts().badge(b) : null; }
  function chipsLine(nodes) {
    var list = (nodes || []).filter(Boolean);
    if (!list.length) return null;
    var c = el('div', 'sc-chips');
    list.forEach(function (n) { c.appendChild(n); });
    return c;
  }
  function marks(list) {
    var items = (list || []).filter(Boolean);
    if (!items.length) return null;
    var line = el('div', 'pc-marks sc-marks');
    items.forEach(function (m) {
      var s = el('span', 'pc-mark' + (m.attn ? ' pc-attn' : ''));
      if (m.title) s.title = m.title;
      if (m.icon) s.appendChild(el('i', m.icon));
      if (m.node) s.appendChild(m.node);
      if (m.value != null) s.appendChild(T((m.icon || m.node ? ' ' : '') + str(m.value)));
      line.appendChild(s);
    });
    return line;
  }

  // ── the three shapes ──────────────────────────────────────────────────
  function doors(list) {
    var box = parts().actions((list || []).filter(Boolean).map(function (a) {
      return a.nodeType ? a : { icon: a.icon, title: a.title, onClick: a.onClick };
    }));
    (list || []).filter(Boolean).forEach(function (a, i) {
      var node = box.children[i];
      if (node && a.destructive) node.classList.add('sc-destructive');
      if (node && a.on) node.classList.add('sc-on');
    });
    return box;
  }
  function stateClass(state) { return state ? ' sc-' + state : ''; }
  function handle(node, opts, kind) {
    node.tabIndex = 0;
    node.setAttribute('data-kind', kind);
    if (opts.onClick) {
      node.classList.add('pc-mod-clickable');
      node.addEventListener('click', function (ev) { opts.onClick(ev, node); });
      node.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter') { ev.preventDefault(); opts.onClick(ev, node); }
      });
    }
    if (opts.selectable) {
      node.addEventListener('click', function (ev) {
        if (ev.target.closest && ev.target.closest('.pc-act, .pc-person, .gc-chip')) return;
        var on = !node.classList.contains('is-selected');
        node.classList.toggle('is-selected', on);
        if (opts.onSelect) opts.onSelect(on, node);
      });
      node.addEventListener('keydown', function (ev) {
        if (ev.key === ' ') { ev.preventDefault(); node.click(); }
      });
    }
  }

  /* d: { kind, title, tag, prefix, id, sub, subTitle, badge, state, theme,
   *      emblem (Node), emblemTitle, readings, extra:[Node], marks, chips:[Node],
   *      foot (Node), attn, err }
   * opts: { doors, onClick, onEmblem, selectable, selected, onSelect } */
  function card(d, opts) {
    opts = opts || {};
    var P = parts();
    var node = el('div', 'sui-planet-card pc-card sc-card sc-quiet' + stateClass(d.state) + (d.theme === 'enemy' ? ' sc-enemy' : ''));
    node.setAttribute('data-id', str(d.id));
    if (d.err) node.classList.add('is-err');
    if (opts.selected) node.classList.add('is-selected');

    var head = el('div', 'sui-planet-card-header');
    var lab = el('div', 'sui-planet-card-header-label');
    var title = el('div', 'sui-planet-card-header-label-title');
    var nm = el('span', 'pc-name');
    if (d.tag) { nm.appendChild(el('span', 'gc-tag', '[' + str(d.tag) + ']')); nm.appendChild(T(' ')); }
    nm.appendChild(el('span', 'pc-nm', str(d.title)));
    nm.title = str(d.title);
    title.appendChild(nm);
    var idl = el('span', 'pc-id');
    idl.appendChild(T('#' + str(d.id) + (d.sub ? ' · ' + str(d.sub) : '')));
    if (d.attn) { idl.appendChild(T(' · ')); idl.appendChild(el('span', 'pc-attn', d.attn)); }
    if (d.subTitle) idl.title = d.subTitle;
    title.appendChild(idl);
    lab.appendChild(title);
    head.appendChild(lab);
    var bd = badge(d.badge);
    if (bd) head.appendChild(bd);
    node.appendChild(head);

    var body = el('div', 'sui-planet-card-body');
    var content = el('div', 'sui-planet-card-body-content pc-body');
    if (d.emblem) {
      if (opts.onEmblem) {
        d.emblem.classList.add('pc-mod-clickable');
        d.emblem.title = d.emblemTitle || '';
        d.emblem.addEventListener('click', function (ev) { ev.stopPropagation(); opts.onEmblem(ev, node); });
      }
      content.appendChild(d.emblem);
    }
    content.appendChild(d.readings && d.readings.nodeType ? d.readings : readings(d.readings));
    body.appendChild(content);
    var ch = chipsLine(d.chips); if (ch) body.appendChild(ch);
    (d.extra || []).forEach(function (x) { if (x) body.appendChild(x); });
    var mk = marks(d.marks); if (mk) body.appendChild(mk);
    var acts = doors(opts.doors);
    if (d.foot || acts.childNodes.length) {
      var foot = el('div', 'pc-foot');
      if (d.foot) foot.appendChild(d.foot);
      if (acts.childNodes.length) foot.appendChild(acts);
      body.appendChild(foot);
    }
    node.appendChild(body);
    handle(node, opts, d.kind || 'card');
    return node;
  }

  /* Same descriptor, one aligned line: emblem | ident | readings | doors. */
  function row(d, opts) {
    opts = opts || {};
    var node = el('div', 'pc-row sc-row sc-quiet' + stateClass(d.state) + (d.theme === 'enemy' ? ' sc-enemy' : ''));
    node.setAttribute('data-id', str(d.id));
    if (d.err) node.classList.add('is-err');
    if (opts.selected) node.classList.add('is-selected');
    if (d.emblem) {
      if (opts.onEmblem) {
        d.emblem.classList.add('pc-mod-clickable');
        d.emblem.title = d.emblemTitle || '';
        d.emblem.addEventListener('click', function (ev) { ev.stopPropagation(); opts.onEmblem(ev, node); });
      }
      node.appendChild(d.emblem);
    }
    var ident = el('div', 'pc-ident');
    var nm = el('div', 'pc-name sui-text-label-block');
    if (d.prefix) { nm.appendChild(el('span', 'pc-prefix', d.prefix)); nm.appendChild(T(' ')); }
    if (d.tag) { nm.appendChild(el('span', 'gc-tag', '[' + str(d.tag) + ']')); nm.appendChild(T(' ')); }
    nm.appendChild(el('span', 'pc-nm', str(d.title)));
    var bd = badge(d.badge); if (bd) nm.appendChild(bd);
    ident.appendChild(nm);
    var idl = el('div', 'pc-id sui-text-label-block');
    // `hideId` for a row whose "id" is a name, not an id (a next move).
    idl.appendChild(T((d.hideId ? '' : '#' + str(d.id) + (d.sub ? ' · ' : '')) + (d.sub ? str(d.sub) : '')));
    if (d.attn) { idl.appendChild(T(' · ')); idl.appendChild(el('span', 'pc-attn', d.attn)); }
    if (d.subTitle) idl.title = d.subTitle;
    ident.appendChild(idl);
    if (d.line3) ident.appendChild(d.line3);
    var ch = chipsLine(d.chips); if (ch) ident.appendChild(ch);
    var mk = marks(d.marks); if (mk) ident.appendChild(mk);
    node.appendChild(ident);
    // Readings and doors travel together: in a narrow frame the whole tail
    // wraps under the identity, right-aligned, never a door alone on a line.
    var tail = el('div', 'sc-tail');
    tail.appendChild(d.readings && d.readings.nodeType ? d.readings : readings(d.readings));
    tail.appendChild(doors(opts.doors));
    node.appendChild(tail);
    handle(node, opts, d.kind || 'row');
    return node;
  }

  /* One inline line. `opts.peek` is a function returning the card to open in
   * place under the chip; `opts.onClick` opens outright. A chip with neither
   * is inert text. */
  function chip(d, opts) {
    opts = opts || {};
    var live = !!(opts.onClick || opts.peek);
    var node = el(live ? 'a' : 'span', 'gc-chip sc-chip' + (d.state ? ' sc-' + d.state : ''));
    if (live) { node.href = 'javascript:void(0)'; node.tabIndex = 0; }
    node.setAttribute('data-id', str(d.id));
    node.setAttribute('data-kind', d.kind || 'chip');
    if (d.emblem) node.appendChild(d.emblem);
    var nm = el('span', 'pc-name');
    if (d.tag) { nm.appendChild(el('span', 'gc-tag', '[' + str(d.tag) + ']')); nm.appendChild(T(' ')); }
    if (d.titleNode) nm.appendChild(d.titleNode); else nm.appendChild(el('span', 'pc-nm', str(d.title)));
    node.appendChild(nm);
    if (d.id != null && d.id !== '' && !d.hideId) { node.appendChild(T(' ')); node.appendChild(el('span', 'pc-id', '#' + str(d.id))); }
    var bd = badge(d.badge); if (bd) { node.appendChild(T(' ')); node.appendChild(bd); }
    if (d.tip) node.title = d.tip;
    else if (opts.peek) node.title = opts.onClick ? 'Click to peek · double-click to open' : 'Click to peek';
    if (opts.peek) {
      node.addEventListener('click', function (ev) {
        ev.preventDefault(); ev.stopPropagation();
        var next = node.nextElementSibling;
        if (next && next.classList.contains('sc-peek')) { next.remove(); node.classList.remove('is-open'); return; }
        var peek = el('div', 'sc-peek');
        peek.appendChild(opts.peek());
        node.parentNode.insertBefore(peek, node.nextSibling);
        node.classList.add('is-open');
      });
      node.addEventListener('keydown', function (ev) {
        if (ev.key === 'Escape') { var n = node.nextElementSibling; if (n && n.classList.contains('sc-peek')) { n.remove(); node.classList.remove('is-open'); } }
      });
      if (opts.onClick) node.addEventListener('dblclick', function (ev) { ev.preventDefault(); ev.stopPropagation(); opts.onClick(ev, node); });
    } else if (opts.onClick) {
      node.addEventListener('click', function (ev) { ev.preventDefault(); ev.stopPropagation(); opts.onClick(ev, node); });
    }
    return node;
  }

  function person(o, opts) { return o && o.id ? parts().personLine(o, opts || {}) : null; }

  // ── the data sets ─────────────────────────────────────────────────────
  // Each takes a plain descriptor; the field lists are the catalogue's.

  /* planet: { id, name, shield, ore, structs:'9 / 16', fleets, raided, unclaimed,
   *           attn, owner:{id,name,tag,pfp}, extra:[Node] } */
  var planet = {
    describe: function (p) {
      var raided = !!p.raided;
      return {
        kind: 'planet', title: p.name || ('Planet ' + p.id), id: p.id, sub: raided ? 'under raid' : p.sub, attn: p.attn,
        state: raided ? 'bad' : (p.unclaimed ? null : 'live'),
        badge: raided ? { text: 'RAIDED', mod: 'destructive' } : p.unclaimed ? { text: 'UNCLAIMED', mod: 'default' } : { text: 'SHIELDED', mod: 'default' },
        readings: [
          p.shield != null ? { value: p.shield, icon: 'sui-icon-md icon-planetary-shield', title: 'Planetary shield' } : null,
          p.ore != null ? { value: p.ore, icon: 'sui-icon-alpha-ore', title: 'Stored ore' } : null,
          p.structs != null ? { value: p.structs, icon: 'sui-icon-deployed-structs', title: 'Structs deployed / slots' } : null,
          p.fleets != null ? { value: p.fleets, icon: 'sui-icon-md icon-fleet-tile', title: 'Fleets on station' } : null,
        ],
        foot: person(p.owner, { title: p.owner && ('Owned by ' + (p.owner.name || p.owner.id)) }),
        extra: p.extra,
      };
    },
    card: function (p, opts) { var d = planet.describe(p); d.emblem = emblem.glyph('icon-planet', null, p.raided ? 'enemy' : 'player'); d.emblemTitle = 'Watch this planet'; return card(d, opts); },
    row: function (p, opts) { var d = planet.describe(p); d.emblem = emblem.glyph('icon-planet', 'sm', p.raided ? 'enemy' : 'player'); d.emblemTitle = 'Watch this planet'; d.line3 = d.foot; d.foot = null; return row(d, opts); },
    chip: function (p, opts) { return chip({ kind: 'planet', emblem: emblem.glyph('icon-planet', 'xs', p.raided ? 'enemy' : 'player'), title: p.name || 'Planet', id: p.id, badge: p.raided ? { text: 'RAIDED', mod: 'destructive' } : null, state: p.raided ? 'bad' : null }, opts); },
  };

  /* fleet: { id, at, away, structs:'8 / 16', reach, awayFor, commandShip:{id,name}, owner, chips } */
  var fleet = {
    describe: function (f) {
      return {
        kind: 'fleet', title: 'Fleet', id: f.id, sub: f.at ? 'at ' + f.at : null, subTitle: f.away ? 'Away' : 'On station', attn: f.attn,
        state: f.away ? 'warn' : 'live', badge: f.away ? { text: 'AWAY', mod: 'warning' } : { text: 'ON STATION', mod: 'default' },
        readings: [
          f.structs != null ? { value: f.structs, icon: 'sui-icon-deployed-structs', title: 'Structs aboard / slots' } : null,
          f.reach != null ? { value: f.reach, icon: 'sui-icon-md icon-ballistic-weapon', title: 'Weapons that reach' } : null,
          f.awayFor != null ? { value: f.awayFor, icon: 'sui-icon-md icon-in-progress', title: 'Time away' } : null,
        ],
        chips: f.chips,
        foot: person(f.owner, { title: f.owner && ('Commanded by ' + (f.owner.name || f.owner.id)) }),
      };
    },
    card: function (f, opts) { var d = fleet.describe(f); d.emblem = emblem.art('Command Ship'); d.emblemTitle = 'Follow this fleet'; return card(d, opts); },
    row: function (f, opts) { var d = fleet.describe(f); d.emblem = emblem.art('Command Ship', 'sm'); d.emblemTitle = 'Follow this fleet'; d.line3 = d.foot; d.foot = null; return row(d, opts); },
    chip: function (f, opts) { return chip({ kind: 'fleet', emblem: emblem.art('Command Ship', 'xs'), title: 'Fleet', id: f.id, badge: f.away ? { text: 'AWAY', mod: 'warning' } : null, state: f.away ? 'warn' : null }, opts); },
  };

  /* struct: { id, type, ambit, location, health, maxHealth, damage, chargeToFire,
   *           online, built, destroyed, building:{frac, eta}, work:{icon,text,title}, chips, owner } */
  var strct = {
    state: function (s) { return s.destroyed ? 'dead' : !s.built ? 'building' : s.online ? 'online' : 'offline'; },
    badgeOf: function (s) {
      var st = strct.state(s);
      return st === 'dead' ? { text: 'DESTROYED', mod: 'destructive' } : st === 'building' ? { text: 'BUILDING', mod: 'warning' } : st === 'online' ? { text: 'ONLINE', mod: 'solid' } : { text: 'OFFLINE', mod: 'default' };
    },
    describe: function (s) {
      var st = strct.state(s);
      var mk = [];
      if (st === 'building' && s.building) mk.push({ icon: 'sui-icon sui-icon-md icon-in-progress', node: progress(s.building.frac), value: s.building.eta, title: 'Build proof ' + Math.round((s.building.frac || 0) * 100) + '%' });
      else if (s.work) mk.push({ icon: 'sui-icon sui-icon-md ' + s.work.icon, value: s.work.text, title: s.work.title });
      return {
        kind: 'struct', title: s.type || ('Struct ' + s.id), id: s.id, sub: s.ambit ? s.ambit + (s.location ? ' · ' + s.location : '') : s.location, subTitle: 'Operating ambit · location', attn: s.attn,
        state: st === 'dead' ? 'bad' : st === 'building' ? 'warn' : st === 'online' ? 'live' : null,
        badge: strct.badgeOf(s),
        readings: [
          s.maxHealth != null ? health(s.destroyed ? 0 : s.health, s.maxHealth) : null,
          s.damage != null ? { value: s.damage, icon: 'sui-icon-md icon-ballistic-weapon', title: 'Damage per shot' } : null,
          s.chargeToFire != null ? { value: s.chargeToFire, icon: 'sui-icon-md icon-range', title: 'Charge to fire' } : null,
        ],
        chips: s.chips, marks: mk,
        foot: person(s.owner, { title: s.owner && ('Owned by ' + (s.owner.name || s.owner.id)) }),
      };
    },
    emblemOf: function (s, size) { return s.destroyed ? emblem.glyph('icon-wreckage', size, 'enemy') : emblem.art(s.type, size); },
    card: function (s, opts) { var d = strct.describe(s); d.emblem = strct.emblemOf(s); d.emblemTitle = 'Watch its planet'; return card(d, opts); },
    row: function (s, opts) { var d = strct.describe(s); d.emblem = strct.emblemOf(s, 'sm'); d.emblemTitle = 'Watch its planet'; d.foot = null; return row(d, opts); },
    chip: function (s, opts) { var st = strct.state(s); return chip({ kind: 'struct', emblem: strct.emblemOf(s, 'xs'), title: s.type || 'Struct', id: s.id, badge: st === 'dead' ? { text: 'DESTROYED', mod: 'destructive' } : null, state: st === 'dead' ? 'bad' : null }, opts); },
  };

  /* substation: { id, guild, load, capacity, fmt, connections, perConnection, owner } */
  var substation = {
    describe: function (s) {
      var thin = s.capacity > 0 && s.load / s.capacity >= 0.9;
      return {
        kind: 'substation', title: 'Substation', id: s.id, sub: s.guild ? 'guild ' + s.guild : null, attn: s.attn,
        state: thin ? 'warn' : 'live', badge: thin ? { text: 'THIN', mod: 'warning' } : { text: 'OPEN', mod: 'default' },
        readings: [
          s.capacity != null ? meter(s.load, s.capacity, s.fmt, 'Load / capacity') : null,
          s.connections != null ? { value: s.connections, icon: 'sui-icon-players', title: 'Connections' } : null,
          s.perConnection != null ? { value: s.perConnection, icon: 'sui-icon-energy', title: 'Capacity per connection' } : null,
        ],
        foot: person(s.owner, { title: s.owner && ('Run by ' + (s.owner.name || s.owner.id)) }),
      };
    },
    card: function (s, opts) { var d = substation.describe(s); d.emblem = emblem.glyph('icon-beacon', null, 'secondary'); return card(d, opts); },
    row: function (s, opts) { var d = substation.describe(s); d.emblem = emblem.glyph('icon-beacon', 'sm', 'secondary'); d.line3 = d.foot; d.foot = null; return row(d, opts); },
    chip: function (s, opts) { var thin = s.capacity > 0 && s.load / s.capacity >= 0.9; return chip({ kind: 'substation', emblem: emblem.glyph('icon-beacon', 'xs', 'secondary'), title: 'Substation', id: s.id, badge: thin ? { text: 'THIN', mod: 'warning' } : null }, opts); },
  };

  /* reactor: { id, guild, fuel, capacity, ratio, commissionPct, history:[..] } */
  var reactor = {
    describe: function (r) {
      return {
        kind: 'reactor', title: 'Reactor', id: r.id, sub: r.guild ? 'guild ' + r.guild : null, state: 'live',
        badge: r.commissionPct != null ? { text: r.commissionPct + '% FEE', mod: 'default' } : null,
        readings: [
          r.fuel != null ? { value: r.fuel, icon: 'sui-icon-alpha-matter', title: 'Fuel infused' } : null,
          r.capacity != null ? { value: r.capacity, icon: 'sui-icon-energy', title: 'Capacity' } : null,
          r.ratio != null ? { value: r.ratio, icon: 'sui-icon-md icon-transfers', title: '1g alpha to power' } : null,
        ],
        extra: r.history && r.history.length > 1 ? [sparkline(r.history, 'player', 'Capacity over time')] : null,
      };
    },
    card: function (r, opts) { var d = reactor.describe(r); d.emblem = emblem.img('img/reactor-64x92.png'); return card(d, opts); },
    row: function (r, opts) { var d = reactor.describe(r); d.emblem = emblem.img('img/reactor-64x92.png', 'sm'); delete d.extra; return row(d, opts); },
    chip: function (r, opts) { return chip({ kind: 'reactor', emblem: emblem.img('img/reactor-64x92.png', 'xs'), title: 'Reactor', id: r.id }, opts); },
  };

  /* agreement: { id, side:'bought'|'sold', providerId, capacity, rate:{value, denomLabel, denomIcon},
   *              left:{text, frac, title}, providerChip:Node, counterparty:{...} } */
  var agreement = {
    rateNode: function (r) {
      var s = el('span', 'pc-res sc-wide'); s.title = 'Price per W per block';
      s.appendChild(T(str(r.value) + ' '));
      if (r.denomIcon) s.appendChild(icon(r.denomIcon));
      else if (r.denomLabel) { s.appendChild(el('span', 'xp-unit', str(r.denomLabel))); s.appendChild(T(' ')); }
      s.appendChild(el('span', 'xp-unit', '/ W / blk'));
      return s;
    },
    describe: function (a) {
      var bought = a.side === 'bought';
      return {
        kind: 'agreement', title: 'Agreement', id: a.id, sub: a.sub || a.side, attn: a.attn,
        state: a.ending ? 'warn' : 'live', badge: bought ? { text: 'BOUGHT', mod: 'default' } : { text: 'SOLD', mod: 'solid' },
        readings: [
          a.capacity != null ? { value: a.capacity, icon: 'sui-icon-energy', title: 'Capacity under contract' } : null,
          a.left ? countdown(a.left.text, a.left.frac, a.left.title) : null,
          a.rate ? agreement.rateNode(a.rate) : null,
        ],
        chips: a.providerChip ? [a.providerChip] : null,
        foot: person(a.counterparty, { title: a.counterparty && ((bought ? 'Provider ' : 'Consumer ') + (a.counterparty.name || a.counterparty.id)) }),
      };
    },
    card: function (a, opts) { var d = agreement.describe(a); d.emblem = emblem.glyph('icon-transfers', null, 'secondary'); return card(d, opts); },
    row: function (a, opts) { var d = agreement.describe(a); d.emblem = emblem.glyph('icon-transfers', 'sm', 'secondary'); d.line3 = d.foot; d.foot = null; d.chips = null; d.readings = d.readings.slice(0, 2); return row(d, opts); },
    chip: function (a, opts) { return chip({ kind: 'agreement', emblem: emblem.glyph('icon-transfers', 'xs', 'secondary'), title: str(a.capacity) + (a.left ? ' · ' + a.left.text : ''), id: a.id, badge: a.side === 'bought' ? { text: 'BOUGHT', mod: 'default' } : { text: 'SOLD', mod: 'solid' } }, opts); },
  };

  /* token: { guildId, tag, name, denom, logo, ratio, collateral, supply, history:[..], prefix } */
  var token = {
    emblemOf: function (t, size) { return t.logo ? emblem.img(t.logo, size) : emblem.glyph('icon-guild', size, 'secondary'); },
    describe: function (t) {
      return {
        kind: 'token', title: t.name || t.denom || ('Token ' + t.guildId), tag: t.tag, id: t.denom || t.guildId, subTitle: 'Chain denom', prefix: t.prefix, state: 'live',
        badge: t.ratio != null ? { text: str(t.ratio), mod: 'default' } : null,
        readings: [
          t.ratio != null ? { value: t.ratio, icon: 'sui-icon-alpha-matter', title: 'Alpha per token' } : null,
          t.collateral != null ? { value: t.collateral, icon: 'sui-icon-md icon-planetary-shield', title: 'Collateral in the pool' } : null,
          t.supply != null ? { value: t.supply, icon: 'sui-icon-players', title: 'Tokens minted' } : null,
        ],
        extra: t.history && t.history.length > 1 ? [sparkline(t.history, 'warning', 'Ratio over time')] : null,
      };
    },
    card: function (t, opts) { var d = token.describe(t); d.emblem = token.emblemOf(t); d.emblemTitle = 'Open the guild'; return card(d, opts); },
    row: function (t, opts) { var d = token.describe(t); d.emblem = token.emblemOf(t, 'sm'); d.badge = null; delete d.extra; return row(d, opts); },
    chip: function (t, opts) {
      var tn = el('span', 'pc-nm'); tn.appendChild(T(str(t.ratio) + ' ')); tn.appendChild(icon('sui-icon-alpha-matter')); tn.appendChild(T(' / ' + str(t.name || t.denom)));
      return chip({ kind: 'token', emblem: token.emblemOf(t, 'xs'), titleNode: tn, id: t.denom || t.guildId }, opts);
    },
  };

  /* task: { id, type:'MINE'|'REFINE'|'BUILD'|'RAID', typeName, status:'running'|'waiting'|'completed', frac, difficulty, eta, structType } */
  var TASK_ICON = { MINE: 'icon-mine', REFINE: 'icon-refine', BUILD: 'icon-in-progress', RAID: 'icon-raid' };
  var task = {
    describe: function (t) {
      var running = t.status === 'running', done = t.status === 'completed';
      return {
        kind: 'task', title: t.typeName || (t.type ? t.type.charAt(0) + t.type.slice(1).toLowerCase() : 'Task'), id: t.id, sub: running || done ? null : t.status, attn: t.attn,
        state: running ? 'live' : null,
        badge: running ? { text: 'RUNNING', mod: 'solid' } : done ? { text: 'DONE', mod: 'default' } : null,
        readings: [
          (function () { var r = el('span', 'pc-res'); r.title = 'Progress ' + Math.round((t.frac || 0) * 100) + '%'; r.appendChild(progress(t.frac)); return r; })(),
          t.difficulty != null ? { value: t.difficulty + ' / 64', icon: 'sui-icon-md icon-key', title: 'Difficulty now, of 64', cls: t.difficulty <= 16 ? 'sc-ok' : (t.difficulty > 32 ? 'sc-bad-text' : null) } : null,
          { value: t.eta || '—', icon: 'sui-icon-md icon-in-progress', title: 'Estimated time to solve' },
        ],
      };
    },
    emblemOf: function (t, size) { return t.structType ? emblem.art(t.structType, size) : emblem.glyph(TASK_ICON[t.type] || 'icon-in-progress', size, 'player'); },
    row: function (t, opts) { var d = task.describe(t); d.emblem = task.emblemOf(t, 'sm'); return row(d, opts); },
    chip: function (t, opts) { return chip({ kind: 'task', emblem: task.emblemOf(t, 'xs'), title: (t.typeName || t.type || 'Task') + (t.difficulty != null && t.status !== 'running' ? ' · ' + t.difficulty + ' / 64' : ''), id: t.id, badge: t.status === 'running' ? { text: 'RUNNING', mod: 'solid' } : null }, opts); },
  };

  /* tx: { id, type, signer, charge, attempts, retryLimit, position, state:'flight'|'queued'|'ok'|'failed'|'skipped',
   *       eta:{text, frac, title}, hash, ago, error } */
  var tx = {
    describe: function (t) {
      var done = t.state === 'ok' || t.state === 'failed' || t.state === 'skipped';
      var subBits = [];
      if (done && t.ago) subBits.push(t.ago);
      if (!done && t.charge != null) subBits.push('charge ' + t.charge);
      return {
        kind: 'tx', prefix: t.position != null ? t.position + '.' : null, title: t.type || '?', id: done ? (t.hash ? str(t.hash).slice(0, 8) + '…' : t.signer || t.id) : (t.signer || t.id),
        sub: subBits.join(' · ') || null, attn: t.attempts > 1 ? 'try ' + t.attempts + (t.retryLimit ? ' / ' + t.retryLimit : '') : (t.error ? str(t.error).slice(0, 80) : null),
        state: t.state === 'failed' ? 'bad' : t.state === 'flight' ? 'live' : null,
        badge: t.state === 'ok' ? { text: 'SUCCESS', mod: 'solid' } : t.state === 'failed' ? { text: 'FAILED', mod: 'destructive' } : t.state === 'skipped' ? { text: 'SKIPPED', mod: 'warning' } : t.state === 'flight' ? { text: 'IN FLIGHT', mod: 'warning' } : null,
        readings: done ? [] : [t.eta ? countdown(t.eta.text, t.eta.frac, t.eta.title) : null],
      };
    },
    emblemOf: function (t, size) {
      return t.state === 'failed' ? emblem.glyph('icon-alert', size, 'enemy') : t.state === 'ok' ? emblem.glyph('icon-success', size, 'player') : t.state === 'skipped' ? emblem.glyph('icon-blocked', size, 'warning') : emblem.glyph('icon-transfers', size, 'secondary');
    },
    row: function (t, opts) { var d = tx.describe(t); d.emblem = tx.emblemOf(t, 'sm'); return row(d, opts); },
    chip: function (t, opts) { var d = tx.describe(t); return chip({ kind: 'tx', emblem: tx.emblemOf(t, 'xs'), title: t.type || '?', id: t.hash ? str(t.hash).slice(0, 8) + '…' : null, badge: d.badge, state: d.state }, opts); },
  };

  /* raid: { planetId, planetName, live, ended, since, shield, ore, oreLabel, shots, attacker, defender, stale } */
  var raid = {
    describe: function (r) {
      return {
        kind: 'raid', title: r.planetName ? 'Raid on ' + r.planetName : 'Raid on ' + r.planetId, id: r.planetId,
        sub: (r.status || (r.live ? 'ongoing' : 'ended')) + (r.since ? ' · ' + r.since : ''), attn: r.stale ? 'stale' : null,
        state: r.live ? 'bad' : null, theme: r.live ? 'enemy' : null,
        badge: r.live ? { text: 'LIVE', mod: 'destructive' } : { text: (r.status || 'ended').toUpperCase(), mod: 'default' },
        readings: [
          r.shield != null ? { value: r.shield, icon: 'sui-icon-md icon-planetary-shield', title: 'Defender shield' } : null,
          r.ore != null ? { value: r.ore, icon: 'sui-icon-alpha-ore', title: r.oreLabel || (r.live ? 'Ore at stake' : 'Ore seized') } : null,
          r.shots != null ? { value: r.shots, icon: 'sui-icon-md icon-dmg', title: 'Shots fired' } : null,
        ],
      };
    },
    card: function (r, opts) { var d = raid.describe(r); d.emblem = emblem.glyph('icon-raid', null, r.live ? 'enemy' : 'hint'); d.emblemTitle = 'Watch the raid'; d.extra = [versus(r.attacker, r.defender, opts)]; return card(d, opts); },
    row: function (r, opts) {
      var d = raid.describe(r); d.emblem = emblem.glyph('icon-raid', 'sm', r.live ? 'enemy' : 'hint'); d.emblemTitle = 'Watch the raid'; d.title = r.planetName || r.planetId; d.theme = null;
      var v = el('div', 'sc-versus-row');
      var A = person(r.attacker), D = person(r.defender);
      if (A) v.appendChild(A); else v.appendChild(el('span', 'pc-id', 'attacker unknown'));
      v.appendChild(el('span', 'fstat-l sc-vs', 'vs'));
      if (D) v.appendChild(D); else v.appendChild(el('span', 'pc-id', 'defender unknown'));
      d.line3 = v;
      return row(d, opts);
    },
    chip: function (r, opts) { return chip({ kind: 'raid', emblem: emblem.glyph('icon-raid', 'xs', r.live ? 'enemy' : 'hint'), title: r.planetName || 'Raid', id: r.planetId, badge: r.live ? { text: 'LIVE', mod: 'destructive' } : null, state: r.live ? 'bad' : null }, opts); },
  };

  /* incident: { at, planetId, mode, fired, planned, attacker, damage, fireTarget, note, advised } */
  var incident = {
    describe: function (i) {
      var none = !i.fired;
      return {
        kind: 'incident', title: i.mode || 'Incident', id: i.at || '?', sub: i.planetId, attn: i.advised ? 'will not fire' : (none ? i.note : null),
        state: none ? 'warn' : 'live',
        badge: { text: str(i.fired || 0) + ' / ' + str(i.planned || 0), mod: none ? 'warning' : 'solid' },
        readings: [
          i.damage != null ? { value: i.damage, icon: 'sui-icon-md icon-dmg', title: 'Projected damage' } : null,
          i.fireTarget ? { value: i.fireTarget, icon: 'sui-icon-md icon-cmd-post', title: 'Fire target' } : null,
        ],
      };
    },
    row: function (i, opts) {
      var d = incident.describe(i); d.emblem = emblem.glyph(i.fired ? 'icon-counter' : 'icon-blocked', 'sm', i.fired ? 'player' : 'warning');
      if (i.attacker && i.attacker.id) { var v = el('div', 'sc-versus-row'); v.appendChild(el('span', 'fstat-l sc-vs', 'at')); v.appendChild(person(i.attacker)); d.line3 = v; }
      return row(d, opts);
    },
    chip: function (i, opts) { return chip({ kind: 'incident', emblem: emblem.glyph(i.fired ? 'icon-counter' : 'icon-blocked', 'xs', i.fired ? 'player' : 'warning'), title: (i.mode || 'Incident') + ' · ' + str(i.fired || 0) + ' / ' + str(i.planned || 0), id: i.planetId }, opts); },
  };

  /* loop: { key, name, on, cadence, lastScan, icon, figures:[{value,icon,title}], holding, dryRun } */
  var loop = {
    switchCtl: function (on, onChange, label) {
      var c = el('div', 'sui-checkbox-container sc-switch');
      var i = el('input', 'sui-checkbox'); i.type = 'checkbox'; i.checked = !!on;
      c.appendChild(i); c.appendChild(el('span', 'sui-checkbox-display')); c.appendChild(el('label', null, label || ''));
      c.title = on ? 'On · click to stop' : 'Off · click to start';
      i.addEventListener('change', function () { if (onChange) onChange(i.checked); });
      c.addEventListener('click', function (ev) { ev.stopPropagation(); });
      return c;
    },
    describe: function (l) {
      return {
        kind: 'loop', title: l.name, id: l.cadence ? 'every ' + l.cadence : (l.key || 'loop'), subTitle: 'Scan cadence', attn: l.dryRun ? 'dry run' : null,
        state: l.holding ? 'warn' : l.on ? 'live' : null,
        badge: l.holding && l.on ? { text: 'HOLDING', mod: 'warning' } : l.on ? { text: 'ON', mod: 'solid' } : { text: 'OFF', mod: 'default' },
        readings: [l.lastScan != null ? { value: l.lastScan, icon: 'sui-icon-md icon-in-progress', title: 'Last scan' } : null].concat(l.figures || []),
        marks: l.holding ? [{ icon: 'sui-icon sui-icon-md icon-attention', value: l.holding, title: 'Why the loop is holding', attn: true }] : null,
      };
    },
    card: function (l, opts) {
      opts = opts || {};
      var d = loop.describe(l); d.emblem = emblem.glyph(l.icon || 'icon-computer', null, l.on ? 'player' : 'hint'); d.emblemTitle = 'Configure';
      d.foot = loop.switchCtl(l.on, opts.onToggle);
      d.foot.setAttribute('data-loop', l.key || '');
      return card(d, opts);
    },
    row: function (l, opts) {
      opts = opts || {};
      var d = loop.describe(l); d.emblem = emblem.glyph(l.icon || 'icon-computer', 'sm', l.on ? 'player' : 'hint');
      var sw = loop.switchCtl(l.on, opts.onToggle); sw.setAttribute('data-loop', l.key || '');
      var o = Object.assign({}, opts, { doors: (opts.doors || []).concat([sw]) });
      return row(d, o);
    },
    chip: function (l, opts) { return chip({ kind: 'loop', emblem: emblem.glyph(l.icon || 'icon-computer', 'xs', l.on ? 'player' : 'hint'), title: l.name, hideId: true, badge: l.holding && l.on ? { text: 'HOLDING', mod: 'warning' } : l.on ? { text: 'ON', mod: 'solid' } : { text: 'OFF', mod: 'default' } }, opts); },
  };

  /* alert: { text, state:'fired'|'quiet'|'unknown'|'bad', value, valueIcon, firedAgo } */
  var alert = {
    describe: function (a) {
      var fired = a.state === 'fired';
      return {
        kind: 'alert', title: a.text, id: fired ? 'fired ' + (a.firedAgo || 'now') : a.state === 'bad' ? 'not a rule' : a.state === 'unknown' ? 'no reading yet' : 'quiet',
        state: fired ? 'bad' : a.state === 'bad' ? 'warn' : null,
        badge: fired ? { text: 'FIRED', mod: 'destructive' } : a.state === 'bad' ? { text: 'INVALID', mod: 'warning' } : a.state === 'unknown' ? { text: 'UNKNOWN', mod: 'default' } : { text: 'QUIET', mod: 'default' },
        readings: [a.value != null ? { value: a.value, icon: a.valueIcon || 'sui-icon-md icon-info', title: 'Reading now' } : null],
      };
    },
    row: function (a, opts) { var d = alert.describe(a); d.emblem = emblem.glyph(a.state === 'fired' ? 'icon-alert' : a.state === 'bad' ? 'icon-attention' : 'icon-okay', 'sm', a.state === 'fired' ? 'enemy' : a.state === 'bad' ? 'warning' : 'hint'); return row(d, opts); },
    chip: function (a, opts) { return chip({ kind: 'alert', emblem: emblem.glyph(a.state === 'fired' ? 'icon-alert' : 'icon-okay', 'xs', a.state === 'fired' ? 'enemy' : 'hint'), title: a.text, hideId: true, badge: a.state === 'fired' ? { text: 'FIRED', mod: 'destructive' } : null, state: a.state === 'fired' ? 'bad' : null }, opts); },
  };

  /* asset: { denom, name, tag, logo, kind:'alpha'|'ore'|'guild'|'other', amount, worth, sendable } */
  var asset = {
    emblemOf: function (a, size) {
      if (a.kind === 'alpha') return emblem.glyph('sui-icon-alpha-matter', size);
      if (a.kind === 'ore') return emblem.glyph('sui-icon-alpha-ore', size);
      if (a.logo) return emblem.img(a.logo, size);
      return emblem.glyph('icon-transfers', size, 'secondary');
    },
    describe: function (a) {
      return {
        kind: 'asset', title: a.name || a.denom, tag: a.tag, id: a.denom, attn: a.sendable === false ? 'not sendable' : null,
        readings: [
          { value: a.amount, icon: a.kind === 'alpha' ? 'sui-icon-alpha-matter' : a.kind === 'ore' ? 'sui-icon-alpha-ore' : 'sui-icon-md icon-transfers', title: 'Balance' },
          a.worth != null ? { value: a.worth, icon: 'sui-icon-alpha-matter', title: 'Worth in alpha at the current ratio' } : null,
        ],
      };
    },
    row: function (a, opts) { var d = asset.describe(a); d.emblem = asset.emblemOf(a, 'sm'); return row(d, opts); },
    chip: function (a, opts) { return chip({ kind: 'asset', emblem: asset.emblemOf(a, 'xs'), title: str(a.amount) + (a.kind === 'alpha' || a.kind === 'ore' ? '' : ' ' + str(a.name || a.denom)), hideId: true }, opts); },
  };

  /* tape: { time, kind, tone, parts:[Node|string], block, fresh } — one grid line, never overlapping. */
  var tape = {
    row: function (e, opts) {
      opts = opts || {};
      var r = el('div', 'sc-tape' + (e.fresh ? ' is-new' : ''));
      r.tabIndex = 0;
      r.appendChild(el('span', 'sc-tape-t fig', e.time || ''));
      var b = badge({ text: e.kind || 'event', mod: e.tone || 'default' }); if (b) r.appendChild(b);
      var body = el('span', 'sc-tape-body');
      (e.parts || []).forEach(function (x) { if (x == null) return; body.appendChild(typeof x === 'string' ? el('span', 'fig', x) : x); });
      if (e.title) body.title = e.title;
      r.appendChild(body);
      r.appendChild(el('span', 'sc-tape-blk fig', e.block != null ? '#' + str(e.block) : ''));
      if (opts.onClick) { r.classList.add('pc-mod-clickable'); r.addEventListener('click', function (ev) { opts.onClick(ev, r); }); }
      return r;
    },
    chip: function (e, opts) { return chip({ kind: 'tape', emblem: emblem.glyph(e.icon || 'icon-info', 'xs', e.tone === 'destructive' ? 'enemy' : 'player'), title: e.text, id: e.subjectId }, opts); },
  };

  /* workspace: { name, cards:[type…], open, windows, changed } */
  var workspace = {
    describe: function (w) {
      var chips = el('div', 'sc-ws-cards');
      (w.cards || []).forEach(function (t) { chips.appendChild(parts().badge({ text: str(t), mod: 'default' })); });
      return {
        kind: 'workspace', title: w.name, id: (w.cards || []).length + ' cards', subTitle: 'Cards in this workspace', state: w.open ? 'live' : null,
        badge: w.open ? { text: 'OPEN', mod: 'solid' } : null,
        readings: [
          w.windows != null ? { value: w.windows, icon: 'sui-icon-md icon-link-out', title: 'Popped-out windows' } : null,
          w.changed != null ? { value: w.changed, icon: 'sui-icon-md icon-in-progress', title: 'Last change' } : null,
        ],
        extra: [chips],
      };
    },
    card: function (w, opts) { var d = workspace.describe(w); d.emblem = emblem.glyph('icon-menu', null, w.open ? 'player' : 'hint'); return card(d, opts); },
    chip: function (w, opts) { return chip({ kind: 'workspace', emblem: emblem.glyph('icon-menu', 'xs', w.open ? 'player' : 'hint'), title: w.name, hideId: true, badge: w.open ? { text: 'OPEN', mod: 'solid' } : null }, opts); },
  };

  root.StructsCards = {
    // primitives
    emblem: emblem, artSlug: artSlug, reading: reading, readings: readings, progress: progress, health: health, meter: meter,
    countdown: countdown, sparkline: sparkline, versus: versus, doors: doors, person: person, chipsLine: chipsLine,
    card: card, row: row, chip: chip,
    // data sets
    planet: planet, fleet: fleet, struct: strct, substation: substation, reactor: reactor, agreement: agreement, token: token,
    task: task, tx: tx, raid: raid, incident: incident, loop: loop, alert: alert, asset: asset, tape: tape, workspace: workspace,
    TASK_ICON: TASK_ICON,
  };
})(typeof window !== 'undefined' ? window : globalThis);
