/* The player card — one component for every place the app shows a player.
 *
 * Team Ops' Armada roster, its Explore search, the Game Stats leaderboards and
 * a player named in Comms all used to draw their own row, and each drifted:
 * different portrait crops, a home-made eight-chunk battery, words under every
 * number. This is the one place a player is drawn, in two shapes:
 *
 *   StructsPlayerCard.card(p, opts)   the game's planet-card frame
 *   StructsPlayerCard.row(p, opts)    one aligned line for long lists
 *
 * `p` is a plain description, already formatted — this file knows nothing
 * about the guild API, the chain, or units:
 *
 *   id        '1-194'                          (required)
 *   name      'MARKLIFER'                      (defaults to the id)
 *   prefix    '#1'                             leaderboard rank, before the name
 *   badge     { text: 'PRIME', mod: 'warning' }  sui-badge; mod ∈ default|warning|destructive|solid
 *   presence  'online' | 'idle' | 'away' | a Node | null
 *   pfp       '{"head":12,…}'                  the on-chain attrs JSON (untrusted; pfp.js validates)
 *   sub       '0-1'                            after the id, on the hint line (keep it short)
 *   guild     '[OH] Orbital Hydro'             the guild, on a line of its own
 *   attn      'last read 3h ago'               warning-coloured, after the id
 *   err       true                             the name turns enemy-red
 *   charge    5                                RAW charge; drawn as the game's 5-chunk battery
 *   readings  [{ value: '40.23Kg', icon: 'sui-icon-alpha-matter', title: 'Alpha' }]
 *   marks     [{ value: '4g', icon: 'icon-undiscovered-ore', title: 'ore left on planet' }]
 *
 * `opts`:
 *   actions     [{ icon: 'icon-planet', title: 'Watch planet', onClick(ev) }]  icon doors
 *   onClick     the card body was clicked (never fires for a portrait or action click)
 *   onPortrait  the portrait was clicked; overrides selection
 *   selectable  the portrait toggles selection (accent frame)
 *   selected    initial selection
 *   onSelect(on, node)
 *
 * Everything is built with textContent — nothing here ever touches innerHTML,
 * because half of what it prints (names, attrs) is other players' data.
 */
(function (root) {
  'use strict';

  /* The game's battery.
   *
   * `ActionBarComponent` draws FIVE chunks and lights them from
   * `ChargeCalculator.calcChargeLevelByCharge`: raw charge → the first
   * threshold it does not exceed. Copied, not re-derived: an eight-chunk
   * one-per-block battery shipped in Team Ops for months and never matched
   * the HUD. playercard.test.mjs pins these against the webapp's own file.
   */
  var CHARGE_LEVEL_THRESHOLDS = [0, 1, 2, 3, 5, 8];
  var BATTERY_CHUNKS = CHARGE_LEVEL_THRESHOLDS.length - 1;

  function chargeLevel(charge) {
    var c = Number(charge);
    if (!isFinite(c)) return 0;
    for (var i = 0; i < CHARGE_LEVEL_THRESHOLDS.length; i++) {
      if (c <= CHARGE_LEVEL_THRESHOLDS[i]) return i;
    }
    return CHARGE_LEVEL_THRESHOLDS.length - 1;
  }

  var BADGE_MODS = { default: 1, warning: 1, destructive: 1, solid: 1 };

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = String(text);
    return e;
  }
  function icon(cls) { return el('i', 'sui-icon ' + cls); }
  function str(v) { return v == null ? '' : String(v); }

  function battery(charge) {
    if (charge == null) return null;
    var lvl = chargeLevel(charge);
    var b = el('span', 'sui-battery sui-theme-player pc-batt');
    b.title = 'charge ' + str(charge);
    for (var i = 0; i < BATTERY_CHUNKS; i++) {
      b.appendChild(el('div', 'sui-battery-chunk' + (i + 1 <= lvl ? ' sui-mod-filled' : '')));
    }
    return b;
  }

  function portrait(attrsJson) {
    var frame = el('div', 'pc-pfp');
    if (root.StructsPfp) root.StructsPfp.fillPortrait(frame, attrsJson);
    return frame;
  }

  function presence(v) {
    if (!v) return null;
    if (v.nodeType) return v;
    var state = v === 'online' || v === 'idle' ? v : 'away';
    var dot = el('span', 'pc-presence pc-mod-' + state);
    dot.title = state === 'online' ? 'Online in Comms' : state === 'idle' ? 'Idle' : 'Away';
    return dot;
  }

  function badge(b) {
    if (!b || !b.text) return null;
    var mod = BADGE_MODS[b.mod] ? b.mod : 'default';
    return el('span', 'sui-badge sui-mod-' + mod, b.text);
  }

  // NAME line: [prefix] [presence] name [badge]
  function nameLine(p, withBadge) {
    var nm = el('div', 'pc-name sui-text-label-block');
    if (p.prefix) nm.appendChild(el('span', 'pc-prefix', p.prefix));
    if (p.prefix) nm.appendChild(document.createTextNode(' '));
    var pr = presence(p.presence);
    if (pr) nm.appendChild(pr);
    nm.appendChild(el('span', 'pc-nm', p.name != null && p.name !== '' ? p.name : p.id));
    if (withBadge) { var bd = badge(p.badge); if (bd) nm.appendChild(bd); }
    return nm;
  }

  // ID line: #id [· sub] [· attn]
  function idLine(p) {
    var s = el('div', 'pc-id sui-text-label-block');
    s.appendChild(document.createTextNode('#' + str(p.id)));
    if (p.sub) s.appendChild(document.createTextNode(' · ' + str(p.sub)));
    if (p.attn) {
      s.appendChild(document.createTextNode(' · '));
      s.appendChild(el('span', 'pc-attn', p.attn));
    }
    return s;
  }

  // GUILD line: its own line, so a long guild name never crowds the id.
  function guildLine(p) {
    if (!p.guild) return null;
    var g = el('div', 'pc-guild sui-text-label-block', p.guild);
    g.title = p.guild;
    return g;
  }

  function reading(r) {
    var s = el('span', 'pc-res');
    if (r.title) s.title = r.title;
    s.appendChild(document.createTextNode(str(r.value)));
    if (r.icon) s.appendChild(icon(r.icon));
    // A reading with no glyph still says what it is, as a small hint.
    else if (r.title) s.appendChild(el('span', 'pc-res-hint', r.title));
    return s;
  }

  function readings(p) {
    var box = el('div', 'pc-reads');
    var b = battery(p.charge);
    if (b) box.appendChild(b);
    (p.readings || []).forEach(function (r) { if (r) box.appendChild(reading(r)); });
    return box;
  }

  function marks(p) {
    var list = (p.marks || []).filter(Boolean);
    if (!list.length) return null;
    var line = el('div', 'pc-marks');
    list.forEach(function (m) {
      var s = el('span', 'pc-mark');
      if (m.title) s.title = m.title;
      if (m.icon) s.appendChild(el('i', m.icon));
      s.appendChild(document.createTextNode((m.icon ? ' ' : '') + str(m.value)));
      line.appendChild(s);
    });
    return line;
  }

  function actions(list) {
    var box = el('div', 'pc-actions');
    (list || []).forEach(function (a) {
      if (!a) return;
      if (a.nodeType) { box.appendChild(a); return; }
      var d = el('a', 'pc-act');
      d.href = 'javascript:void(0)';
      if (a.title) d.title = a.title;
      d.appendChild(icon('sui-icon-md ' + a.icon));
      d.addEventListener('click', function (ev) {
        // An action is never also a card click.
        ev.stopPropagation();
        if (a.onClick) a.onClick(ev, d);
      });
      box.appendChild(d);
    });
    return box;
  }

  function setSelected(node, on) {
    node.classList.toggle('is-selected', !!on);
  }

  // Wire the portrait: a callback wins, otherwise selection, otherwise inert.
  function wirePortrait(frame, node, opts) {
    if (opts.onPortrait) {
      frame.classList.add('pc-mod-clickable');
      frame.addEventListener('click', function (ev) {
        ev.stopPropagation();
        opts.onPortrait(ev, node);
      });
    } else if (opts.selectable) {
      frame.classList.add('pc-mod-clickable');
      frame.title = 'Select';
      frame.addEventListener('click', function (ev) {
        ev.stopPropagation();
        var on = !node.classList.contains('is-selected');
        setSelected(node, on);
        if (opts.onSelect) opts.onSelect(on, node);
      });
    }
  }

  function wireClick(node, opts) {
    if (!opts.onClick) return;
    node.classList.add('pc-mod-clickable');
    node.addEventListener('click', function (ev) { opts.onClick(ev, node); });
  }

  function common(node, p, opts) {
    node.setAttribute('data-player-id', str(p.id));
    if (p.err) node.classList.add('is-err');
    if (opts.selected) setSelected(node, true);
  }

  /* ── the planet-card frame ─────────────────────────────────────────── */
  function card(p, opts) {
    opts = opts || {};
    var node = el('div', 'sui-planet-card pc-card');
    common(node, p, opts);

    var head = el('div', 'sui-planet-card-header');
    var lab = el('div', 'sui-planet-card-header-label');
    var title = el('div', 'sui-planet-card-header-label-title');
    // The game's title block is two spans; ours are the name line and the id
    // line, so the frame's own type rules dress them.
    var nm = nameLine(p, false); nm.classList.remove('sui-text-label-block');
    var nmSpan = el('span'); nmSpan.className = nm.className; nmSpan.title = str(p.name || p.id);
    while (nm.firstChild) nmSpan.appendChild(nm.firstChild);
    title.appendChild(nmSpan);
    var idl = idLine(p); idl.classList.remove('sui-text-label-block');
    var idSpan = el('span'); idSpan.className = idl.className;
    while (idl.firstChild) idSpan.appendChild(idl.firstChild);
    title.appendChild(idSpan);
    var gl = guildLine(p);
    if (gl) { var gSpan = el('span'); gSpan.className = gl.className.replace('sui-text-label-block', '').trim(); gSpan.title = gl.title; gSpan.textContent = gl.textContent; title.appendChild(gSpan); }
    lab.appendChild(title);
    head.appendChild(lab);
    var bd = badge(p.badge);
    if (bd) head.appendChild(bd);
    node.appendChild(head);

    var body = el('div', 'sui-planet-card-body');
    var content = el('div', 'sui-planet-card-body-content pc-body');
    var frame = portrait(p.pfp);
    wirePortrait(frame, node, opts);
    content.appendChild(frame);
    content.appendChild(readings(p));
    body.appendChild(content);

    var mk = marks(p);
    var acts = actions(opts.actions);
    if (mk || acts.childNodes.length) {
      var foot = el('div', 'pc-foot');
      if (mk) foot.appendChild(mk);
      if (acts.childNodes.length) foot.appendChild(acts);
      body.appendChild(foot);
    }
    node.appendChild(body);
    wireClick(node, opts);
    return node;
  }

  /* ── one aligned line ──────────────────────────────────────────────── */
  function row(p, opts) {
    opts = opts || {};
    var node = el('div', 'pc-row');
    common(node, p, opts);

    var frame = portrait(p.pfp);
    wirePortrait(frame, node, opts);
    node.appendChild(frame);

    var ident = el('div', 'pc-ident');
    ident.appendChild(nameLine(p, true));
    ident.appendChild(idLine(p));
    var gl = guildLine(p);
    if (gl) ident.appendChild(gl);
    var mk = marks(p);
    if (mk) ident.appendChild(mk);
    node.appendChild(ident);

    node.appendChild(readings(p));
    node.appendChild(actions(opts.actions));
    wireClick(node, opts);
    return node;
  }

  root.StructsPlayerCard = {
    // The building blocks, for the card's siblings (guildcard.js draws a guild
    // with the same readings, doors and frame). One vocabulary, one file.
    parts: { el: el, icon: icon, badge: badge, reading: reading, actions: actions,
             wireClick: wireClick, BADGE_MODS: BADGE_MODS },
    CHARGE_LEVEL_THRESHOLDS: CHARGE_LEVEL_THRESHOLDS,
    BATTERY_CHUNKS: BATTERY_CHUNKS,
    chargeLevel: chargeLevel,
    battery: battery,
    portrait: portrait,
    card: card,
    row: row,
    setSelected: setSelected,
  };
})(typeof window !== 'undefined' ? window : globalThis);
