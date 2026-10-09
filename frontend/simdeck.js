/* COMMAND DECK — window.SimDeck, the Battle Simulator's component builders.
 *
 * Every builder returns DOM made with createElement + textContent (never an
 * HTML string) styled by frontend/simdeck.css (.d-*). Glyphs and sprites are
 * aria-hidden; icon-only keys carry aria-label + title; portraits go through
 * StructsPfp.fillPortrait (player attrs never reach markup).
 *
 * COMMON OPTIONS
 *   opts.into  an existing element to fill: the builder adds its classes
 *              (and drops the state classes it added last time), empties it
 *              and keeps its id and attributes. Listeners are bound once per
 *              element, so filling the same node again never doubles them.
 *   opts.id    the id of a new root (battery: of its range input).
 *   opts.cls   extra classes for the root.
 *   SIZES are the DESIGN numbers (2x): glyph 24 draws 12 CSS, ship 64 draws 32.
 *
 * FOUNDATIONS
 *   el(tag, cls, text)                      → element (text via textContent)
 *   sr(text)                                → span.d-sr (visually hidden)
 *   glyph(name, size=24, cls)               → i.sui-icon.icon-NAME.d-gly (16 | 24 | 32)
 *   sprite(name, size=24, cls)              → i.sui-icon.sui-icon-NAME.d-ico (16 | 24 | 32)
 *   ship(slug, size=64, {foe, dead, skull, cls})
 *                                           → span.d-ship.is-SIZE; slug = SimulatorHost.typeSlug(type)
 *   pf(attrs, {size=48, tone:'you'|'them'|'violet'|'bare', cpu, cls})
 *                                           → span.d-pf (24 | 32 | 48 | 64)
 *   led(tone='teal'|'amber'|'coral'|'violet'|'off', lg) → span.d-led
 *   hp(n, max, lg)                          → span.d-hp of max segments, spent .is-off
 *   chevs(level, {small, max=3, label})     → span.d-chevs, lit from the bottom
 *   brackets(kind='friendly'|'enemy'|'move', small) → span.d-brackets
 *   vs()                                    → span.d-vs 'VS'
 *
 * SURFACES
 *   panel({tag='section', label, tone:'player'|'enemy'|'warn', glyph, sprite, title,
 *          right:[nodes], body:'tight'|'flush', foot:[nodes]|false, into, id, cls})
 *                                           → {root, head, title, right, body, foot}
 *   sec(label, value)                       → {root, head, value}   (.d-sec)
 *   rule()                                  → div.d-rule
 *   screen(children, {framed, center, tall, into, id, cls}) → div.d-screen
 *
 * CHOICE
 *   cards({labelledby|label, items:[{value, label, count, rank, dice, title, disabled}],
 *          current, onPick(value), into, id, cls})
 *                                           → {root, set(value)}  radiogroup of button.d-card;
 *                                             clicking ANY card picks (Random rerolls); arrows/Home/End
 *   structCard({slug, ambit, name, hp, dmg, current, disabled, title, ariaLabel, onClick, onShow(slug), into, id, cls})
 *                                           → button.d-card.is-struct
 *   seg({label|labelledby, options:[{value, label, sub, disabled}], current, onPick(value), disabled, into, id, cls})
 *                                           → {root, set(value)}  radiogroup of button.d-seg-opt
 *   rank({id, label='Opponent', level, levels=['easy','difficult','hard'], words=['Easy','Difficult','Hard'],
 *         disabled, onPick(level), into, cls})
 *                                           → {root, set(level, disabled)}  div.d-rank[data-value]
 *   battery({id, side:'you'|'foe', label, value, max=30, slim, readout, mirror, disabled, hint,
 *            mark, ariaLabel, onInput(v), onChange(v), into, cls})
 *                                           → {root, input, value(), set({value, hint, mark, disabled, label})}
 *                                             input is a real range (null for a readout)
 *   mini(cost, {foe, grouped, of=cost, bare}) → span.d-mini role=img 'Costs N charge'
 *                                             (bare: no number, aria-hidden)
 *
 * BOARD
 *   tile({side:'friend'|'foe', ambit, slug, cmd, empty, selected, target, eligible, dead, dim,
 *         slotOn, static, size:56, hp:[n,max], defending, defended, reticle, skull, plus,
 *         label, disabled, button=true, onClick, into, id, cls})
 *                                           → button.d-tile (span when static or button:false)
 *   reach(ambits {space,air,land,water} | ['space',…], {bare, label}) → span.d-reach role=img
 *   fleet({foe, name, count, reach, into, id, cls}) → div.d-fleet
 *
 * INSPECTOR
 *   hero({ambit, short, slug, foe, tag, into, id, cls})   → div.d-hero
 *   facts(items:[{hp:[n,max]} | {sprite|glyph, n, text, unit}], {into, id, cls}) → div.d-facts
 *   key({ability, glyph, caption, title, pressed, tone:'defense'|'offense', disabled, onClick, into, id, cls})
 *                                           → button.d-key[data-ability]
 *   weapon({kind:'ballistic'|'smart', name, dmg, cost, reach, off, into, cls}) → div.d-weapon
 *   guard({ward:{slug, name}|null, picking, disabled, onClear, onPick, into, id, cls})
 *                                           → {root, pick, clear}  (.d-guard)
 *
 * KEYS
 *   btn({text, glyph, glyphAfter, tone:'teal'|'violet'|'coral'|'amber', size:'sm'|'sm20'|'lg', square,
 *        pressed, disabled, id, title, ariaLabel, onClick, into, cls}) → button.d-btn
 *   iconBtn({glyph, label, coral, disabled, id, onClick, into, cls})   → button.d-iconbtn
 *   tool({text, glyph, caret, pressed, disabled, id, title, onClick, into, cls}) → button.d-tool
 *   launch({text, glyph='chevron-right', block, auto, disabled, id, onClick, into, cls})
 *                                           → button.d-launch > span label + glyph
 *   menu({items:[{id, text, glyph, onClick, disabled, hidden} | {sep:true} | {header:text}], label, pop, id})
 *                                           → div.d-menu role=menu (items: button.d-menu-item role=menuitem)
 *   bindMenu(opener, menuEl)                → {open(), close(), isOpen()}; wires built AND static menus
 *
 * COMMAND + TOP BAR
 *   ready({tone:'ok'|'warn'|'bad', head, detail, title, into, id, cls}) → div.d-ready
 *   mode(node|null, {text, tone:'challenge'|'live'|null, glyph, pfAttrs}) → span.d-mode (fills node)
 *   pill({text, tone:'teal'|'amber'|'coral'|'violet'|null, solid, led, ledTone, pfAttrs, chevs,
 *         glyph, title, id, into, cls})    → span.d-pill
 *
 * MODAL
 *   modal({id, parent=document.body, tone:'teal'|'warn'|'bad'|'violet', railGlyph, title, titleId,
 *          meta, metaId, body:node|string|[nodes], cta:[nodes], ctaColumn, width:'sm'|'md'|'wide'|'engage',
 *          role:'dialog'|'alertdialog'|'status', kept, focus:node, onCancel, backdropCancels})
 *     → {overlay, dialog, rail, main, titleEl, metaEl, body, cta, show(), hide(), close(), isOpen()}
 *     div.d-scrim#id > div.d-modal > rail + main (h2.d-modal-t + meta, .d-modal-b, .d-modal-cta).
 *     A body node is MOVED in (keeps its id, loses 'hidden'). Escape cancels the TOPMOST open
 *     modal (default: hide when kept, else close); Tab cycles inside it; show() focuses
 *     opts.focus or the first control and hide() gives focus back. role=status: no trap.
 *   modalOpen()                             → the topmost open modal handle, or null
 *
 * DEBRIEF + SOCIAL
 *   stats({head:{you, them}|null, sprites, rows:[{ic|sprite|glyph, glyphTone, label, you, them}], into, id, cls})
 *                                             ic: any node for the row's icon cell
 *                                           → div.d-stats (0 values get .is-zero)
 *   timeline({n, events:[{block, side:'you'|'them', slug, label, kill}], into, id, cls})
 *                                           → div.d-timeline (left = block/n as a %, close events stagger)
 *   verdict({word, tone:'victory'|'defeat'|'draw', reason, facts, into, wordId, reasonId, factsId, id, cls})
 *                                           → div.d-verdict > h1.d-verdict-t
 *   alert({tone:'teal'|'amber'|'coral'|'neutral', led=true, head, detail, sub, actions:[nodes], into, id, cls})
 *                                           → div.d-alert
 *   lrow({rank, pfAttrs, name, time, won, me, fresh, pill, seat}) → li.d-lrow
 *                                             (seat: .is-seat, no rank or verdict — face, name, pill)
 *   ladder(rows:[lrow opts | li], {into, id, cls}) → ol.d-ladder
 *   msg({name, time, body, self, foe})      → div.d-msg
 *   composer({pfAttrs, input, send, placeholder, label, into, id, cls}) → {root, input, send}
 *   roster(items:[{slug, foe, dead}], tight) → div.d-roster
 *
 * FITTING
 *   fitRow(box)                             a no-wrap row keeps whole children or none (display:none)
 *   fitTimeline(box)                        eases a drawn timeline's captions apart and inside box
 */
(function () {
  'use strict';

  var AMBITS = ['space', 'air', 'land', 'water'];
  var seq = 0;
  function uid(p) { seq += 1; return 'd-' + p + '-' + seq; }

  // ── DOM helpers ─────────────────────────────────────────────────────────
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = String(text);
    return e;
  }
  function o(opts) { return opts || {}; }
  function hide(node) { node.setAttribute('aria-hidden', 'true'); return node; }
  function add(parent, kids) {
    if (kids == null || kids === false) return parent;
    if (!Array.isArray(kids)) kids = [kids];
    kids.forEach(function (k) {
      if (k == null || k === false) return;
      parent.appendChild(typeof k === 'object' ? k : document.createTextNode(String(k)));
    });
    return parent;
  }
  function words(s) { return String(s || '').split(/\s+/).filter(Boolean); }
  /* The root of a builder: a fresh element, or opts.into refilled in place.
   * The classes added last time are remembered on the node and dropped first,
   * so a re-render that turns a state off actually turns it off. */
  function root(tag, cls, opts, skipId) {
    opts = o(opts);
    var all = words(cls).concat(words(opts.cls));
    var n = opts.into;
    if (n) {
      (n._dkCls || []).forEach(function (c) { n.classList.remove(c); });
      all.forEach(function (c) { n.classList.add(c); });
      n._dkCls = all;
      n.replaceChildren();
    } else {
      n = el(tag, all.join(' '));
      if (opts.id && !skipId) n.id = opts.id;
    }
    return n;
  }
  /* One listener per element and event, whose handler is swapped on refill. */
  function on(node, type, fn) {
    node._dkOn = node._dkOn || {};
    if (!node._dkOn[type]) {
      node.addEventListener(type, function (e) { var f = node._dkOn[type]; if (f) f.call(node, e); });
    }
    node._dkOn[type] = fn || null;
  }
  function setBool(node, attr, v) {
    if (v == null) node.removeAttribute(attr);
    else node.setAttribute(attr, v ? 'true' : 'false');
  }
  function button(cls, opts) {
    var b = root('button', cls, opts);
    b.type = 'button';
    return b;
  }

  // ── Foundations ─────────────────────────────────────────────────────────
  function sizeCls(size, base) { return size && size !== base ? ' is-' + size : ''; }
  function glyph(name, size, cls) {
    return hide(el('i', 'sui-icon icon-' + name + ' d-gly' + sizeCls(size, 24) + (cls ? ' ' + cls : '')));
  }
  function sprite(name, size, cls) {
    return hide(el('i', 'sui-icon sui-icon-' + name + ' d-ico' + sizeCls(size, 24) + (cls ? ' ' + cls : '')));
  }
  function sr(text) { return el('span', 'd-sr', text); }
  /* ExtremeHazard has no '·': in a chrome label each ' · ' becomes a small
   * square (.d-sep) that still reads, and copies, as the dot. */
  function spaced(node, text) {
    String(text).split(' · ').forEach(function (part, i) {
      if (i) { node.appendChild(document.createTextNode(' ')); node.appendChild(el('span', 'd-sep', '·')); node.appendChild(document.createTextNode(' ')); }
      node.appendChild(document.createTextNode(part));
    });
    return node;
  }
  function ship(slug, size, opts) {
    opts = o(opts);
    var s = el('span', 'd-ship is-' + (size || 64) + (opts.foe ? ' is-foe' : '') + (opts.dead ? ' is-dead' : '') + (opts.cls ? ' ' + opts.cls : ''));
    var A = window.BattleArt, art = A && A.ART[slug];
    if (art) {
      var layer = function (suffix, tag) {
        var img = el('img', tag);
        img.src = A.artPath(art.dir, suffix);
        img.alt = '';
        img.draggable = false;
        s.appendChild(img);
      };
      (art.bottom || []).forEach(function (l) { layer(l, 'struct-bottom-detail'); });
      layer('struct-base', null);
      (art.top || []).forEach(function (l) { layer(l, 'struct-top-detail'); });
    }
    if (opts.skull) s.appendChild(sprite('destroyed', 16, 'd-ship-x'));
    return s;
  }
  function pf(attrs, opts) {
    opts = o(opts);
    var size = opts.size || 48;
    var p = hide(el('span', 'd-pf' + sizeCls(size, 48) + (opts.tone ? ' is-' + opts.tone : '') + (opts.cpu ? ' is-cpu' : '') + (opts.cls ? ' ' + opts.cls : '')));
    if (opts.cpu) p.appendChild(glyph('computer', size >= 48 ? 32 : 16));
    else if (window.StructsPfp) window.StructsPfp.fillPortrait(p, attrs || null);
    return p;
  }
  function led(tone, lg) {
    var t = tone && tone !== 'teal' && tone !== 'ok' ? ' is-' + tone : '';
    return hide(el('span', 'd-led' + t + (lg ? ' is-lg' : '')));
  }
  function hp(n, max, lg) {
    var h = hide(el('span', 'd-hp' + (lg ? ' is-lg' : '')));
    for (var i = 0; i < (max || 0); i++) h.appendChild(el('span', 'd-hp-s' + (i < n ? '' : ' is-off')));
    return h;
  }
  function chevs(level, opts) {
    opts = o(opts);
    var max = opts.max || 3;
    var c = el('span', 'd-chevs' + (opts.small ? ' is-sm' : ''));
    if (opts.label) { c.setAttribute('role', 'img'); c.setAttribute('aria-label', opts.label); } else hide(c);
    for (var i = 0; i < max; i++) c.appendChild(el('span', 'd-chev' + (i >= max - (level || 0) ? ' is-lit' : '')));
    return c;
  }
  var BRACKET = { friendly: 'd-bracket-friendly', enemy: 'd-bracket-enemy', move: 'd-move-target' };
  function brackets(kind, small) {
    return hide(el('span', 'd-brackets ' + (BRACKET[kind] || BRACKET.friendly) + (small ? ' is-sm' : '')));
  }
  function vs() { return el('span', 'd-vs', 'VS'); }

  // ── Surfaces ────────────────────────────────────────────────────────────
  function panel(opts) {
    opts = o(opts);
    var r = root(opts.tag || 'section', 'd-panel' + (opts.tone ? ' is-' + opts.tone : ''), opts);
    if (opts.label) r.setAttribute('aria-label', opts.label);
    var head = el('header', 'd-panel-h');
    if (opts.glyph) head.appendChild(glyph(opts.glyph, 16));
    if (opts.sprite) head.appendChild(sprite(opts.sprite));
    var title = spaced(el('span'), opts.title != null ? opts.title : '');
    head.appendChild(title);
    var right = add(el('span', 'd-panel-r'), opts.right);
    head.appendChild(right);
    var body = el('div', 'd-panel-b' + (opts.body ? ' is-' + opts.body : ''));
    r.appendChild(head);
    r.appendChild(body);
    var foot = null;
    if (Array.isArray(opts.foot)) { foot = add(el('footer', 'd-panel-f'), opts.foot); r.appendChild(foot); }
    return { root: r, head: head, title: title, right: right, body: body, foot: foot };
  }
  function sec(label, value) {
    var r = el('div', 'd-sec');
    var head = el('div', 'd-sec-h');
    head.appendChild(el('span', null, label));
    var v = null;
    if (value != null) { v = add(el('span', 'd-sec-v'), value); head.appendChild(v); }
    r.appendChild(head);
    return { root: r, head: head, value: v };
  }
  function rule() { return hide(el('div', 'd-rule')); }
  function screen(children, opts) {
    opts = o(opts);
    var r = root('div', 'd-screen' + (opts.framed ? ' is-framed' : '') + (opts.center ? ' is-center' : '') + (opts.tall ? ' is-tall' : ''), opts);
    return add(r, children);
  }

  // ── Roving radio groups (cards, seg, rank) ──────────────────────────────
  var NEXT = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
  function roving(buttons, current, e, pick) {
    var live = buttons.filter(function (b) { return !b.disabled; });
    if (!live.length) return;
    var i = live.indexOf(current), to = null;
    if (e.key in NEXT) to = live[(i + NEXT[e.key] + live.length) % live.length];
    else if (e.key === 'Home') to = live[0];
    else if (e.key === 'End') to = live[live.length - 1];
    if (!to) return;
    e.preventDefault();
    to.focus();
    pick(to);
  }
  function groupLabel(r, opts) {
    r.setAttribute('role', 'radiogroup');
    if (opts.labelledby) r.setAttribute('aria-labelledby', opts.labelledby);
    else if (opts.label) r.setAttribute('aria-label', opts.label);
  }
  function pressGroup(buttons, value, attr) {
    var hit = null;
    buttons.forEach(function (b) {
      var yes = b.dataset.value === String(value);
      b.setAttribute(attr, yes ? 'true' : 'false');
      if (yes) hit = b;
    });
    var first = hit || buttons.filter(function (b) { return !b.disabled; })[0] || null;
    buttons.forEach(function (b) { b.tabIndex = b === first ? 0 : -1; });
  }

  function cards(opts) {
    opts = o(opts);
    var r = root('div', 'd-cards', opts);
    groupLabel(r, opts);
    var list = [];
    var api = { root: r, set: function (v) { pressGroup(list, v, 'aria-checked'); } };
    function pick(b) { api.set(b.dataset.value); if (opts.onPick) opts.onPick(b.dataset.value); }
    (opts.items || []).forEach(function (it) {
      var b = el('button', 'd-card');
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.dataset.value = String(it.value);
      if (it.title) b.title = it.title;
      if (it.disabled) b.disabled = true;
      var top = el('span', 'd-card-top');
      top.appendChild(el('span', 'd-card-l', it.label));
      if (it.dice) top.appendChild(glyph('refresh-12', 16));
      var pay = el('span', 'd-card-pay');
      var n = el('span', 'd-card-n', it.count != null ? it.count : '');
      if (!it.dice) n.appendChild(sprite('enemy-deployed-structs'));
      pay.appendChild(n);
      if (it.rank) pay.appendChild(chevs(it.rank, { small: true }));
      b.appendChild(top);
      b.appendChild(pay);
      b.appendChild(brackets('friendly'));
      b.setAttribute('aria-label', it.label + (it.count != null ? ', ' + it.count + ' enemy structs' : ''));
      b.addEventListener('click', function () { pick(b); });
      b.addEventListener('keydown', function (e) { roving(list, b, e, pick); });
      list.push(b);
      r.appendChild(b);
    });
    api.set(opts.current);
    return api;
  }

  function structCard(opts) {
    opts = o(opts);
    var b = button('d-card is-struct', opts);
    var art = el('span', 'd-card-art' + (opts.ambit ? ' d-t-' + opts.ambit : ''));
    art.appendChild(ship(opts.slug, 64));
    var body = el('span', 'd-card-body');
    body.appendChild(el('span', 'd-card-name', opts.name));
    var stat = el('span', 'd-card-stat');
    if (opts.hp != null) stat.appendChild(hp(opts.hp, opts.hp));
    if (opts.dmg != null) stat.appendChild(el('span', null, opts.dmg + ' dmg'));
    body.appendChild(stat);
    b.appendChild(art);
    b.appendChild(body);
    b.appendChild(brackets('friendly'));
    b.disabled = !!opts.disabled;
    if (opts.current) b.setAttribute('aria-current', 'true'); else b.removeAttribute('aria-current');
    if (opts.title) b.title = opts.title;
    if (opts.ariaLabel) b.setAttribute('aria-label', opts.ariaLabel);
    on(b, 'click', opts.onClick);
    var show = opts.onShow ? function () { opts.onShow(opts.slug); } : null;
    on(b, 'mouseenter', show);
    on(b, 'focus', show);
    return b;
  }

  function seg(opts) {
    opts = o(opts);
    var r = root('div', 'd-seg', opts);
    groupLabel(r, opts);
    var list = [];
    var api = { root: r, set: function (v) { pressGroup(list, v, 'aria-checked'); } };
    function pick(b) { api.set(b.dataset.value); if (opts.onPick) opts.onPick(b.dataset.value); }
    (opts.options || []).forEach(function (op) {
      var b = el('button', 'd-seg-opt', op.label);
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.dataset.value = String(op.value);
      if (op.sub != null) b.appendChild(el('span', 'd-seg-sub', op.sub));
      if (opts.disabled || op.disabled) b.disabled = true;
      b.addEventListener('click', function () { pick(b); });
      b.addEventListener('keydown', function (e) { roving(list, b, e, pick); });
      list.push(b);
      r.appendChild(b);
    });
    api.set(opts.current);
    return api;
  }

  function rank(opts) {
    opts = o(opts);
    var levels = opts.levels || ['easy', 'difficult', 'hard'];
    var names = opts.words || ['Easy', 'Difficult', 'Hard'];
    var r = root('div', 'd-rank', opts);
    r.setAttribute('role', 'radiogroup');
    r.setAttribute('aria-label', 'Opponent skill');
    r.appendChild(el('span', 'd-rank-l', opts.label != null ? opts.label : 'Opponent'));
    var pips = el('span', 'd-rank-pips');
    var word = el('span', 'd-rank-word');
    var list = [];
    var state = { level: opts.level, disabled: !!opts.disabled };
    function set(level, disabled) {
      if (level != null) state.level = level;
      if (disabled != null) state.disabled = !!disabled;
      var at = levels.indexOf(state.level);
      r.dataset.value = state.level == null ? '' : String(state.level);
      r.classList.toggle('is-disabled', state.disabled);
      setBool(r, 'aria-disabled', state.disabled ? true : null);
      list.forEach(function (p, i) {
        p.classList.toggle('is-lit', i <= at);
        p.setAttribute('aria-checked', i === at ? 'true' : 'false');
        p.disabled = state.disabled;
        p.tabIndex = i === (at < 0 ? 0 : at) ? 0 : -1;
      });
      word.textContent = at < 0 ? '' : names[at];
    }
    function pick(p) {
      if (state.disabled) return;
      var lv = levels[list.indexOf(p)];
      set(lv);
      if (opts.onPick) opts.onPick(lv);
    }
    levels.forEach(function (lv, i) {
      var p = el('button', 'd-pip');
      p.type = 'button';
      p.setAttribute('role', 'radio');
      p.setAttribute('aria-label', names[i]);
      p.addEventListener('click', function () { pick(p); });
      p.addEventListener('keydown', function (e) { roving(list, p, e, pick); });
      list.push(p);
      pips.appendChild(p);
    });
    r.appendChild(pips);
    r.appendChild(word);
    set(opts.level, opts.disabled);
    return { root: r, set: set };
  }

  // ── Charge battery ──────────────────────────────────────────────────────
  function battery(opts) {
    opts = o(opts);
    var max = opts.max || 30;
    var foe = opts.side === 'foe';
    var r = root('div', 'd-battery' + (foe ? ' is-foe' : '') + (opts.slim ? ' is-slim' : '') + (opts.mirror ? ' is-mirror' : '') + (opts.readout ? ' is-readout' : ''), opts, true);
    var head = el('div', 'd-batt-h');
    var side = el('span', 'd-batt-side', opts.label != null ? opts.label : (foe ? 'Computer' : 'You'));
    var hint = el('span', 'd-batt-hint', opts.hint != null ? opts.hint : '');
    head.appendChild(side);
    head.appendChild(hint);
    var val = hide(el('span', 'd-batt-val'));
    var track = el('div', 'd-batt-track');
    var input = null;
    if (!opts.readout) {
      input = el('input', 'd-batt-range');
      input.type = 'range';
      input.min = '0';
      input.max = String(max);
      input.step = '1';
      if (opts.id) input.id = opts.id;
      if (opts.ariaLabel) input.setAttribute('aria-label', opts.ariaLabel);
      track.appendChild(input);
    }
    var cellsBox = hide(el('span', 'd-cells'));
    var cells = [];
    for (var g = 0; g < Math.ceil(max / 5); g++) {
      var group = el('span', 'd-cell-g');
      for (var c = 0; c < 5 && g * 5 + c < max; c++) { var cell = el('span', 'd-cell'); cells.push(cell); group.appendChild(cell); }
      cellsBox.appendChild(group);
    }
    track.appendChild(cellsBox);
    r.appendChild(head);
    r.appendChild(val);
    r.appendChild(track);

    var state = { value: 0, mark: opts.mark || 0, disabled: !!opts.disabled, label: side.textContent };
    function clamp(v) { v = Math.round(Number(v)); return isFinite(v) ? Math.max(0, Math.min(max, v)) : 0; }
    function paint() {
      var v = state.value;
      cells.forEach(function (cl, i) {
        cl.classList.toggle('is-lit', i < v);
        cl.classList.toggle('is-head', i === v - 1);
        cl.classList.toggle('is-mark', i === state.mark - 1);
      });
      val.textContent = String(v);
      if (input) input.value = String(v);
      if (opts.readout) {
        r.setAttribute('role', 'img');
        r.setAttribute('aria-label', state.label + ' opening charge ' + v);
      }
    }
    function lock() {
      r.classList.toggle('is-disabled', state.disabled);
      if (input) input.disabled = state.disabled;
    }
    function change(v) {   // a user change: repaint in place, tell the page
      v = clamp(v);
      if (v === state.value) return;
      state.value = v;
      paint();
      if (opts.onInput) opts.onInput(v);
      if (input) input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    if (input) {
      input.addEventListener('input', function () {
        var v = clamp(input.value);
        if (v === state.value) return;
        state.value = v;
        paint();
        if (opts.onInput) opts.onInput(v);
      });
      input.addEventListener('change', function () { if (opts.onChange) opts.onChange(state.value); });
      /* The pointer maps to the NEAREST cell rect, so the group gaps never
       * make a click land one off; past the first cell is 0. */
      var at = function (x) {
        var first = cells[0].getBoundingClientRect();
        if (opts.mirror ? x > first.right : x < first.left) return 0;
        var best = 0, dist = Infinity;
        cells.forEach(function (cl, i) {
          var b = cl.getBoundingClientRect(), d = Math.abs(x - (b.left + b.width / 2));
          if (d < dist) { dist = d; best = i; }
        });
        return best + 1;
      };
      var dragging = false;
      track.addEventListener('pointerdown', function (e) {
        if (state.disabled) return;
        e.preventDefault();
        input.focus();
        dragging = true;
        if (track.setPointerCapture && e.pointerId != null) { try { track.setPointerCapture(e.pointerId); } catch (err) { /* synthetic */ } }
        change(at(e.clientX));
      });
      track.addEventListener('pointermove', function (e) { if (dragging) change(at(e.clientX)); });
      var end = function () {
        if (!dragging) return;
        dragging = false;
        if (opts.onChange) opts.onChange(state.value);
      };
      track.addEventListener('pointerup', end);
      track.addEventListener('pointercancel', end);
    }
    state.value = clamp(opts.value || 0);
    paint();
    lock();
    return {
      root: r, input: input,
      value: function () { return state.value; },
      set: function (s) {
        s = o(s);
        if (s.label != null) { state.label = String(s.label); side.textContent = state.label; }
        if (s.hint != null) hint.textContent = String(s.hint);
        if (s.mark != null) state.mark = s.mark;
        if (s.disabled != null) { state.disabled = !!s.disabled; lock(); }
        if (s.value != null) state.value = clamp(s.value);
        paint();
      },
    };
  }

  function mini(cost, opts) {
    opts = o(opts);
    var of = opts.of != null ? opts.of : cost;
    var m = el('span', 'd-mini' + (opts.foe ? ' is-foe' : '') + (opts.grouped ? ' is-grouped' : ''));
    // Bare: the meter alone, as a picture beside words that already say it.
    if (opts.bare) hide(m);
    else {
      m.setAttribute('role', 'img');
      m.setAttribute('aria-label', 'Costs ' + cost + ' charge');
    }
    for (var i = 0; i < of; i++) {
      m.appendChild(el('span', 'd-mini-c' + (i < cost ? ' is-lit' : '') + ((i + 1) % 5 === 0 && i + 1 < of ? ' is-gap' : '')));
    }
    if (!opts.bare) m.appendChild(el('span', 'd-mini-n', cost));
    return m;
  }

  // ── Board ───────────────────────────────────────────────────────────────
  function tile(opts) {
    opts = o(opts);
    var isButton = !opts.static && opts.button !== false;
    var cls = 'd-tile is-' + (opts.side === 'foe' ? 'foe' : 'friend');
    if (opts.ambit) cls += ' d-t-' + opts.ambit;
    if (opts.size === 56) cls += ' is-56';
    [['cmd', 'is-cmd'], ['empty', 'is-empty'], ['selected', 'is-selected'], ['target', 'is-target'], ['eligible', 'is-eligible'],
      ['dead', 'is-dead'], ['static', 'is-static'], ['dim', 's-dim'], ['slotOn', 's-slot-on']].forEach(function (p) { if (opts[p[0]]) cls += ' ' + p[1]; });
    var t = isButton ? button(cls, opts) : root('span', cls, opts);
    if (opts.label) {
      if (!isButton) t.setAttribute('role', 'img');
      t.setAttribute('aria-label', opts.label);
    }
    if (isButton) {
      t.disabled = !!opts.disabled;
      on(t, 'click', opts.onClick);
    }
    if (opts.empty) {
      if (opts.plus !== false) t.appendChild(glyph('add', 24, 'd-tile-plus'));
    } else if (opts.slug) {
      t.appendChild(ship(opts.slug, opts.size === 56 ? 48 : 64, { foe: opts.side === 'foe', dead: opts.dead }));
    }
    if (opts.hp) t.appendChild(hp(opts.hp[0], opts.hp[1]));
    if (opts.defending || opts.defended) {
      var marks = hide(el('span', 'd-marks'));
      if (opts.defending) marks.appendChild(sprite('defending', 16));
      if (opts.defended) marks.appendChild(sprite('defended', 16));
      t.appendChild(marks);
    }
    if (opts.reticle || (opts.target && opts.reticle !== false)) t.appendChild(glyph('range', 16, 'd-reticle'));
    if (opts.skull || (opts.dead && opts.skull !== false)) t.appendChild(sprite('destroyed', 16, 'd-tile-badge'));
    t.appendChild(hide(el('span', 'd-brackets')));
    return t;
  }

  function reach(ambits, opts) {
    opts = o(opts);
    var has = function (a) { return Array.isArray(ambits) ? ambits.indexOf(a) >= 0 : !!(ambits && ambits[a]); };
    var lit = AMBITS.filter(has);
    var r = el('span', 'd-reach' + (opts.bare ? ' is-bare' : ''));
    r.setAttribute('role', 'img');
    r.setAttribute('aria-label', opts.label || (lit.length === 4 ? 'Reaches every ambit'
      : lit.length ? 'Reaches ' + listing(lit) : 'Reaches nothing'));
    AMBITS.forEach(function (a) { r.appendChild(sprite(a, 24, has(a) ? null : 'is-off')); });
    return r;
  }
  function listing(xs) { return xs.length < 2 ? xs.join('') : xs.slice(0, -1).join(', ') + ' and ' + xs[xs.length - 1]; }

  function fleet(opts) {
    opts = o(opts);
    var r = root('div', 'd-fleet' + (opts.foe ? ' is-foe' : ''), opts);
    r.appendChild(el('span', 'd-fleet-name', opts.name));
    var count = el('span', 'd-fleet-count');
    count.appendChild(sprite(opts.foe ? 'enemy-deployed-structs' : 'deployed-structs'));
    count.appendChild(document.createTextNode(String(opts.count != null ? opts.count : 0)));
    r.appendChild(count);
    if (opts.reach) r.appendChild(opts.reach.nodeType ? opts.reach : reach(opts.reach));
    return r;
  }

  // ── Inspector ───────────────────────────────────────────────────────────
  function hero(opts) {
    opts = o(opts);
    var r = root('div', 'd-hero' + (opts.short ? ' is-short' : '') + (opts.ambit ? ' d-t-' + opts.ambit : ''), opts);
    if (opts.slug) r.appendChild(ship(opts.slug, 128, { foe: opts.foe }));
    if (opts.tag != null) r.appendChild(pill({ text: opts.tag, tone: opts.foe ? 'coral' : 'teal', cls: 'd-hero-tag' }));
    return r;
  }
  function facts(items, opts) {
    var r = root('div', 'd-facts', opts);
    (items || []).forEach(function (it) {
      var f = el('span', 'd-fact');
      if (it.hp) {
        f.appendChild(hp(it.hp[0], it.hp[1], true));
        f.appendChild(el('span', 'd-fact-n', it.hp[0] + '/' + it.hp[1]));
      } else {
        if (it.sprite) f.appendChild(sprite(it.sprite, 16));
        if (it.glyph) f.appendChild(glyph(it.glyph, 16));
        if (it.text != null) f.appendChild(document.createTextNode(String(it.text)));
        if (it.n != null) {
          var n = el('span', 'd-fact-n', it.n);
          if (it.unit) n.appendChild(el('span', 'd-unit', it.unit));
          f.appendChild(n);
        } else if (it.unit) f.appendChild(el('span', 'd-unit', it.unit));
      }
      r.appendChild(f);
    });
    return r;
  }
  function key(opts) {
    opts = o(opts);
    var b = button('d-key' + (opts.tone ? ' is-' + opts.tone : ''), opts);
    if (opts.ability) b.dataset.ability = opts.ability;
    if (opts.title || opts.caption) b.title = opts.title || opts.caption;
    setBool(b, 'aria-pressed', opts.pressed == null ? null : !!opts.pressed);
    b.disabled = !!opts.disabled;
    var face = el('span', 'd-key-face');
    face.appendChild(glyph(opts.glyph || 'move'));
    b.appendChild(face);
    b.appendChild(el('span', 'd-key-cap', opts.caption != null ? opts.caption : ''));
    on(b, 'click', opts.onClick);
    return b;
  }
  function weapon(opts) {
    opts = o(opts);
    var r = root('div', 'd-weapon' + (opts.off ? ' is-off' : ''), opts);
    r.appendChild(glyph(opts.kind === 'smart' ? 'smart-weapon' : 'ballistic-weapon', 24, 'd-weapon-g'));
    var name = el('span', 'd-weapon-n', opts.name);
    if (opts.name) name.title = opts.name;
    r.appendChild(name);
    var dmg = el('span', 'd-weapon-dmg', opts.dmg != null ? opts.dmg : '');
    dmg.appendChild(el('span', 'd-unit', 'DMG'));
    r.appendChild(dmg);
    var sub = el('span', 'd-weapon-sub');
    if (opts.cost != null) sub.appendChild(mini(opts.cost));
    if (opts.reach) {
      var lit = AMBITS.filter(function (a) { return Array.isArray(opts.reach) ? opts.reach.indexOf(a) >= 0 : opts.reach[a]; });
      sub.appendChild(reach(opts.reach, { bare: true, label: lit.length === 4 ? 'Hits every ambit' : lit.length ? 'Hits ' + listing(lit) : 'Hits nothing' }));
    }
    r.appendChild(sub);
    return r;
  }
  function guard(opts) {
    opts = o(opts);
    var ward = opts.ward;
    var r = root('div', 'd-guard' + (opts.picking ? ' is-picking' : (ward ? '' : ' is-empty')), opts);
    var slot = el('div', 'd-guard-slot');
    var clear = null;
    if (opts.picking) {
      slot.appendChild(el('span', 'd-guard-n', 'Choose on the board'));
    } else if (ward) {
      slot.appendChild(ship(ward.slug, 32));
      slot.appendChild(el('span', 'd-guard-n', ward.name));
      clear = iconBtn({ glyph: 'close', label: 'Stop guarding', onClick: opts.onClear });
      clear.disabled = !!opts.disabled;
      slot.appendChild(clear);
    } else {
      slot.appendChild(el('span', 'd-guard-n', 'Not guarding anyone'));
    }
    r.appendChild(slot);
    var pick = btn({ glyph: 'range', square: true, size: 'sm', tone: 'teal', ariaLabel: 'Pick on board', title: 'Pick on board', pressed: !!opts.picking, disabled: opts.disabled, onClick: opts.onPick });
    r.appendChild(pick);
    return { root: r, pick: pick, clear: clear };
  }

  // ── Keys ────────────────────────────────────────────────────────────────
  var SIZE = { sm: ' is-sm', sm20: ' is-sm is-20', lg: ' is-lg' };
  function btn(opts) {
    opts = o(opts);
    var b = button('d-btn' + (opts.tone ? ' is-' + opts.tone : '') + (SIZE[opts.size] || '') + (opts.square ? ' is-sq' : ''), opts);
    if (opts.glyph) b.appendChild(glyph(opts.glyph, opts.size === 'sm' || opts.size === 'sm20' ? 16 : 24));
    if (opts.text != null) b.appendChild(el('span', null, opts.text));
    if (opts.glyphAfter) b.appendChild(glyph(opts.glyphAfter, opts.size === 'sm' || opts.size === 'sm20' ? 16 : 24));
    setBool(b, 'aria-pressed', opts.pressed == null ? null : !!opts.pressed);
    var name = opts.ariaLabel || (opts.square && opts.text == null ? opts.title : null);
    if (name) b.setAttribute('aria-label', name);
    if (opts.title || (opts.square && name)) b.title = opts.title || name;
    b.disabled = !!opts.disabled;
    on(b, 'click', opts.onClick);
    return b;
  }
  function iconBtn(opts) {
    opts = o(opts);
    var b = button('d-iconbtn' + (opts.coral ? ' is-coral' : ''), opts);
    b.appendChild(glyph(opts.glyph || 'close', 16));
    if (opts.label) { b.setAttribute('aria-label', opts.label); b.title = opts.label; }
    b.disabled = !!opts.disabled;
    on(b, 'click', opts.onClick);
    return b;
  }
  function tool(opts) {
    opts = o(opts);
    var b = button('d-tool', opts);
    if (opts.glyph) b.appendChild(glyph(opts.glyph));
    if (opts.text != null) b.appendChild(el('span', null, opts.text));
    if (opts.caret) b.appendChild(glyph('caret-down', 16, 'd-tool-caret'));
    if (opts.title) b.title = opts.title;
    setBool(b, 'aria-pressed', opts.pressed == null ? null : !!opts.pressed);
    b.disabled = !!opts.disabled;
    on(b, 'click', opts.onClick);
    return b;
  }
  function launch(opts) {
    opts = o(opts);
    var b = button('d-launch' + (opts.block ? ' is-block' : '') + (opts.auto ? ' is-auto' : ''), opts);
    b.appendChild(el('span', null, opts.text != null ? opts.text : ''));
    b.appendChild(glyph(opts.glyph || 'chevron-right'));
    b.disabled = !!opts.disabled;
    on(b, 'click', opts.onClick);
    return b;
  }

  // ── Menu ────────────────────────────────────────────────────────────────
  function menu(opts) {
    opts = o(opts);
    var m = el('div', 'd-menu' + (opts.pop ? ' is-pop' : ''));
    if (opts.id) m.id = opts.id;
    m.setAttribute('role', 'menu');
    if (opts.label) m.setAttribute('aria-label', opts.label);
    (opts.items || []).forEach(function (it) {
      if (it.sep) { var s = el('div', 'd-menu-sep'); s.setAttribute('role', 'separator'); m.appendChild(s); return; }
      if (it.header != null) { m.appendChild(hide(el('div', 'd-menu-h', it.header))); return; }
      var b = el('button', 'd-menu-item');
      b.type = 'button';
      b.setAttribute('role', 'menuitem');
      if (it.id) b.id = it.id;
      if (it.glyph) b.appendChild(glyph(it.glyph, 16));
      b.appendChild(el('span', null, it.text));
      if (it.disabled) b.disabled = true;
      if (it.hidden) b.classList.add('hidden');
      if (it.onClick) b.addEventListener('click', it.onClick);
      m.appendChild(b);
    });
    return m;
  }
  function shown(n) { return !n.hidden && !n.classList.contains('hidden'); }
  function bindMenu(opener, m) {
    if (m._dkMenu) return m._dkMenu;
    if (!m.id) m.id = uid('menu');
    m.setAttribute('role', 'menu');
    opener.setAttribute('aria-haspopup', 'menu');
    opener.setAttribute('aria-controls', m.id);
    opener.setAttribute('aria-expanded', 'false');
    m.hidden = true;
    var items = function () {
      return Array.prototype.filter.call(m.querySelectorAll('.d-menu-item'), function (b) { return shown(b) && !b.disabled; });
    };
    var seps = function () {   // a separator with nothing visible after it goes too
      Array.prototype.forEach.call(m.querySelectorAll('.d-menu-sep'), function (s) {
        var n = s.nextElementSibling, any = false;
        while (n && !n.classList.contains('d-menu-sep')) {
          if (n.classList.contains('d-menu-item') && shown(n)) { any = true; break; }
          n = n.nextElementSibling;
        }
        s.hidden = !any;
      });
    };
    var outside = function (e) { if (!m.contains(e.target) && !opener.contains(e.target)) api.close(); };
    var api = {
      isOpen: function () { return !m.hidden; },
      open: function () {
        if (!m.hidden) return;
        seps();
        m.hidden = false;
        opener.setAttribute('aria-expanded', 'true');
        document.addEventListener('pointerdown', outside, true);
        var first = items()[0];
        if (first) first.focus();
      },
      close: function (refocus) {
        if (m.hidden) return;
        var inside = m.contains(document.activeElement);
        m.hidden = true;
        opener.setAttribute('aria-expanded', 'false');
        document.removeEventListener('pointerdown', outside, true);
        if (refocus || inside) opener.focus();
      },
    };
    opener.addEventListener('click', function () { if (api.isOpen()) api.close(); else api.open(); });
    opener.addEventListener('keydown', function (e) {
      if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !api.isOpen()) { e.preventDefault(); api.open(); }
      else if (e.key === 'Escape' && api.isOpen()) { e.preventDefault(); e.stopPropagation(); api.close(true); }
    });
    m.addEventListener('keydown', function (e) {
      var list = items(), i = list.indexOf(document.activeElement), to = null;
      if (e.key === 'ArrowDown') to = list[(i + 1) % list.length];
      else if (e.key === 'ArrowUp') to = list[(i - 1 + list.length) % list.length];
      else if (e.key === 'Home') to = list[0];
      else if (e.key === 'End') to = list[list.length - 1];
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); api.close(true); return; }
      else if (e.key === 'Tab') { api.close(false); return; }
      if (to) { e.preventDefault(); to.focus(); }
    });
    // Captured, before the item's own handler: the menu closes and focus is
    // back on its opener first, so a dialog the item opens returns focus
    // there when it closes.
    m.addEventListener('click', function (e) {
      var it = e.target.closest ? e.target.closest('.d-menu-item') : null;
      if (it && !it.disabled) api.close(true);
    }, true);
    m._dkMenu = api;
    return api;
  }

  // ── Command + top bar ───────────────────────────────────────────────────
  function ready(opts) {
    opts = o(opts);
    var tone = opts.tone === 'warn' || opts.tone === 'bad' ? opts.tone : 'ok';
    var r = root('div', 'd-ready' + (tone === 'ok' ? '' : ' is-' + tone), opts);
    r.appendChild(led(tone === 'warn' ? 'amber' : tone === 'bad' ? 'coral' : 'teal', true));
    var t = el('div', 'd-ready-t');
    t.appendChild(el('span', 'd-ready-h', opts.head != null ? opts.head : ''));
    t.appendChild(el('span', 'd-ready-d', opts.detail != null ? opts.detail : ''));
    r.appendChild(t);
    r.title = [opts.head, opts.detail, opts.title].filter(function (s) { return s != null && s !== ''; }).join(' · ');
    return r;
  }
  function mode(node, opts) {
    opts = o(opts);
    var r = root('span', 'd-mode' + (opts.tone ? ' is-' + opts.tone : ''), { into: node || null });
    if (opts.pfAttrs != null || (opts.tone === 'live' && !opts.glyph)) r.appendChild(pf(opts.pfAttrs, { size: 24, tone: 'bare' }));
    else r.appendChild(glyph(opts.glyph || (opts.tone === 'challenge' ? 'raid' : 'computer'), 16));
    r.appendChild(spaced(el('span'), opts.text != null ? opts.text : 'Simulator'));
    return r;
  }
  var LED_FOR = { teal: 'teal', amber: 'amber', coral: 'coral', violet: 'violet' };
  function pill(opts) {
    opts = o(opts);
    var r = root('span', 'd-pill' + (opts.tone ? ' is-' + opts.tone : '') + (opts.solid ? ' is-solid' : ''), opts);
    if (opts.led) r.appendChild(led(opts.ledTone || LED_FOR[opts.tone] || 'teal'));
    if (opts.pfAttrs != null) r.appendChild(pf(opts.pfAttrs, { size: 24, tone: 'bare' }));
    if (opts.chevs) r.appendChild(chevs(opts.chevs, { small: true }));
    if (opts.glyph) r.appendChild(glyph(opts.glyph, 16));
    if (opts.text != null) r.appendChild(spaced(el('span'), opts.text));
    if (opts.title) r.title = opts.title;
    return r;
  }

  // ── Modal ───────────────────────────────────────────────────────────────
  var stack = [];
  var FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]';
  function focusables(box) {
    return Array.prototype.filter.call(box.querySelectorAll(FOCUSABLE), function (n) {
      return !n.disabled && n.tabIndex >= 0 && !(n.closest && n.closest('.hidden, [hidden]'));
    });
  }
  function topModal() { return stack.length ? stack[stack.length - 1] : null; }
  document.addEventListener('keydown', function (e) {
    var top = topModal();
    if (!top) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopImmediatePropagation();
      top._cancel();
    } else if (e.key === 'Tab') {
      var list = focusables(top.dialog);
      if (!list.length) { e.preventDefault(); top.dialog.focus(); return; }
      var first = list[0], last = list[list.length - 1], at = document.activeElement;
      var inside = top.dialog.contains(at);
      if (e.shiftKey && (at === first || !inside)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (at === last || !inside)) { e.preventDefault(); first.focus(); }
    }
  });
  var RAIL = { teal: 'in-progress', warn: 'attention', bad: 'alert', violet: 'link-out' };
  function modal(opts) {
    opts = o(opts);
    var tone = opts.tone || 'teal';
    var role = opts.role || 'dialog';
    var overlay = el('div', 'd-scrim hidden');
    if (opts.id) overlay.id = opts.id;
    var dialog = el('div', 'd-modal' + (tone !== 'teal' ? ' is-' + tone : '') + (opts.width && opts.width !== 'sm' ? ' is-' + opts.width : ''));
    dialog.setAttribute('role', role);
    dialog.tabIndex = -1;
    if (role !== 'status') dialog.setAttribute('aria-modal', 'true');
    var titleId = opts.titleId || uid('modal-t');
    dialog.setAttribute('aria-labelledby', titleId);
    var rail = el('div', 'd-modal-rail');
    rail.appendChild(glyph(opts.railGlyph || RAIL[tone] || RAIL.teal, 32));
    var main = el('div', 'd-modal-main');
    var head = el('div', 'd-modal-h');
    var titleEl = el('h2', 'd-modal-t', opts.title != null ? opts.title : '');
    titleEl.id = titleId;
    var metaEl = el('span', 'd-modal-meta', opts.meta != null ? opts.meta : '');
    if (opts.metaId) metaEl.id = opts.metaId;
    head.appendChild(titleEl);
    head.appendChild(metaEl);
    var body = el('div', 'd-modal-b');
    (Array.isArray(opts.body) ? opts.body : [opts.body]).forEach(function (b) {
      if (b && b.nodeType) b.classList.remove('hidden');
    });
    add(body, opts.body);
    var cta = add(el('div', 'd-modal-cta' + (opts.ctaColumn ? ' is-col' : '')), opts.cta);
    main.appendChild(head);
    main.appendChild(body);
    main.appendChild(cta);
    dialog.appendChild(rail);
    dialog.appendChild(main);
    overlay.appendChild(dialog);
    var parent = opts.parent || document.body;
    parent.appendChild(overlay);

    var prev = null, open = false;
    var h = {
      overlay: overlay, dialog: dialog, rail: rail, main: main, titleEl: titleEl, metaEl: metaEl, body: body, cta: cta,
      isOpen: function () { return open; },
      show: function () {
        if (open) return h;
        if (!overlay.isConnected) parent.appendChild(overlay);
        overlay.classList.remove('hidden');
        open = true;
        if (role === 'status') return h;
        prev = document.activeElement;
        stack.push(h);
        var to = opts.focus || focusables(dialog)[0] || dialog;
        if (to && to.focus) to.focus();
        return h;
      },
      hide: function () {
        if (!open) { if (!opts.kept && overlay.parentNode) overlay.parentNode.removeChild(overlay); return h; }
        open = false;
        var i = stack.indexOf(h);
        if (i >= 0) stack.splice(i, 1);
        overlay.classList.add('hidden');
        if (!opts.kept && overlay.parentNode) overlay.parentNode.removeChild(overlay);
        if (prev && prev.isConnected && prev.focus) prev.focus();
        prev = null;
        return h;
      },
      close: function () {
        h.hide();
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        return h;
      },
      _cancel: function () {
        if (opts.onCancel) opts.onCancel(h);
        else if (opts.kept) h.hide();
        else h.close();
      },
    };
    if (opts.backdropCancels) {
      overlay.addEventListener('pointerdown', function (e) { if (e.target === overlay && open) h._cancel(); });
    }
    return h;
  }
  function modalOpen() { return topModal(); }

  // ── Debrief + social ────────────────────────────────────────────────────
  function stats(opts) {
    opts = o(opts);
    var r = root('div', 'd-stats', opts);
    var row = function (cls) { var s = el('div', 'd-stat' + (cls ? ' ' + cls : '')); return s; };
    var val = function (side, v, text) {
      var n = el('span', 'd-stat-v is-' + side + (Number(v) === 0 && text == null ? ' is-zero' : ''), text != null ? text : v);
      return n;
    };
    if (opts.head) {
      var hr = row('is-head');
      hr.appendChild(el('span', 'd-stat-ic'));
      hr.appendChild(el('span', 'd-stat-l'));
      hr.appendChild(el('span', 'd-stat-lead'));
      if (opts.sprites) {
        hide(hr);
        var y = el('span', 'd-stat-v is-you'); y.appendChild(sprite('deployed-structs'));
        var t = el('span', 'd-stat-v is-them'); t.appendChild(sprite('enemy-deployed-structs'));
        hr.appendChild(y);
        hr.appendChild(t);
      } else {
        hr.appendChild(val('you', null, opts.head.you != null ? opts.head.you : 'You'));
        if (opts.head.them !== null) hr.appendChild(val('them', null, opts.head.them != null ? opts.head.them : 'Them'));
      }
      r.appendChild(hr);
    }
    (opts.rows || []).forEach(function (it) {
      var s = row();
      var ic = el('span', 'd-stat-ic');
      if (it.ic) ic.appendChild(it.ic);
      else if (it.sprite) ic.appendChild(sprite(it.sprite, 32));
      else if (it.glyph) ic.appendChild(glyph(it.glyph, 32, it.glyphTone ? 'is-' + it.glyphTone : null));
      s.appendChild(ic);
      s.appendChild(el('span', 'd-stat-l', it.label));
      s.appendChild(el('span', 'd-stat-lead'));
      s.appendChild(val('you', it.you));
      if (it.them !== undefined) s.appendChild(val('them', it.them));
      r.appendChild(s);
    });
    return r;
  }

  function pct(x) { return String(Math.max(0, Math.min(100, Math.round(x * 1000) / 10))) + '%'; }
  function timeline(opts) {
    opts = o(opts);
    var n = Math.max(1, opts.n || 1);
    var r = root('div', 'd-timeline', opts);
    var track = el('div', 'd-tl-track');
    track.appendChild(hide(el('span', 'd-tl-axis')));
    track.appendChild(el('span', 'd-tl-end is-start', '0'));
    track.appendChild(el('span', 'd-tl-end is-stop', n));
    [0.25, 0.5, 0.75].forEach(function (f) { var t = hide(el('span', 'd-tl-tick')); t.style.left = pct(f); track.appendChild(t); });
    /* Same-side events within 12% of n would overlap (an event is as wide as
     * 12% of a typical track): the earlier caption hangs left (.is-lead), the
     * later one right (.is-stagger). Markers that would touch (within 5%, or
     * a third in a row) are held one marker apart (.is-stack): never less
     * than the previous event's left + 18. */
    var last = { you: null, them: null };
    (opts.events || []).slice().sort(function (a, b) { return a.block - b.block; }).forEach(function (ev) {
      var side = ev.side === 'them' ? 'them' : 'you';
      var prev = last[side];
      var gap = prev ? ev.block - prev.block : Infinity;
      var stagger = gap < 0.12 * n;
      var stack = stagger && (gap < 0.05 * n || prev.stagger);
      if (stagger && !prev.stagger) prev.node.classList.add('is-lead');
      var e = el('div', 'd-tl-ev is-' + side + (ev.kill ? ' is-kill' : '') + (stagger ? ' is-stagger' : '') + (stack ? ' is-stack' : ''));
      var left = pct(ev.block / n);
      if (stack) left = 'max(' + left + ', calc(' + prev.left + ' + var(--spacing-xl) + var(--spacing-xs)))';
      last[side] = { block: ev.block, stagger: stagger, node: e, left: left };
      e.style.left = left;
      var cap = el('span', 'd-tl-cap');
      cap.appendChild(el('span', 'd-tl-blk', 'B' + ev.block));
      cap.appendChild(el('span', 'd-tl-lbl', ev.label));
      var mk = el('span', 'd-tl-mk');
      mk.appendChild(ship(ev.slug, 32, { foe: side === 'them' }));
      if (ev.kill) mk.appendChild(sprite('destroyed', 16, 'd-tl-skull'));
      e.appendChild(cap);
      e.appendChild(mk);
      e.appendChild(hide(el('span', 'd-tl-stem')));
      track.appendChild(e);
    });
    r.appendChild(track);
    return r;
  }

  function verdict(opts) {
    opts = o(opts);
    var tone = opts.tone === 'defeat' || opts.tone === 'draw' ? ' is-' + opts.tone : '';
    var r = root('div', 'd-verdict' + tone, opts);
    var w = el('h1', 'd-verdict-t', opts.word != null ? opts.word : '');
    if (opts.wordId) w.id = opts.wordId;
    r.appendChild(w);
    var sub = el('div', 'd-verdict-sub', opts.reason != null ? opts.reason : '');
    if (opts.reasonId) sub.id = opts.reasonId;
    r.appendChild(sub);
    if (opts.facts || opts.factsId) {
      var f = facts(opts.facts || []);
      if (opts.factsId) f.id = opts.factsId;
      r.appendChild(f);
    }
    return r;
  }

  var ALERT_LED = { teal: 'teal', amber: 'amber', coral: 'coral', neutral: 'off' };
  function alert(opts) {
    opts = o(opts);
    var tone = opts.tone || 'teal';
    var r = root('div', 'd-alert' + (tone !== 'teal' ? ' is-' + tone : ''), opts);
    if (opts.led !== false) r.appendChild(led(ALERT_LED[tone] || 'teal'));
    if (opts.head != null) r.appendChild(spaced(el('span', 'd-alert-h'), opts.head));
    r.appendChild(el('span', 'd-alert-d', opts.detail != null ? opts.detail : ''));
    if (opts.sub != null) r.appendChild(el('span', 'd-alert-sub', opts.sub));
    add(r, opts.actions);
    return r;
  }

  function lrow(opts) {
    opts = o(opts);
    var li = el('li', 'd-lrow' + (opts.me ? ' is-me' : '') + (opts.fresh ? ' is-fresh' : '') + (opts.seat ? ' is-seat' : ''));
    // A seat has no rank and no verdict: face, name, what it owes.
    if (!opts.seat) li.appendChild(el('span', 'd-lrow-n', opts.rank != null ? opts.rank : ''));
    li.appendChild(pf(opts.pfAttrs, { size: 32, tone: opts.me ? 'you' : null }));
    li.appendChild(el('span', 'd-lrow-name', opts.name));
    if (opts.seat) {
      if (opts.pill) li.appendChild(opts.pill);
    } else if (opts.pill) {
      li.appendChild(opts.pill);
      li.appendChild(el('span'));
    } else {
      var tone = opts.won === false ? 'd-coral' : 'd-teal';
      li.appendChild(el('span', 'd-lrow-t ' + tone, opts.time != null ? opts.time : ''));
      li.appendChild(glyph(opts.won === false ? 'close' : 'success', 16, opts.won === false ? 'is-coral' : 'is-teal'));
    }
    return li;
  }
  function ladder(rows, opts) {
    var r = root('ol', 'd-ladder', opts);
    (rows || []).forEach(function (x) { r.appendChild(x && x.nodeType ? x : lrow(x)); });
    return r;
  }
  function msg(opts) {
    opts = o(opts);
    var m = el('div', 'd-msg' + (opts.self ? ' is-self' : '') + (opts.foe ? ' is-foe' : ''));
    var h = el('div', 'd-msg-h');
    h.appendChild(el('span', null, opts.name));
    if (opts.time != null) h.appendChild(el('span', 'd-msg-t', opts.time));
    m.appendChild(h);
    m.appendChild(el('p', 'd-msg-b', opts.body));
    return m;
  }
  function composer(opts) {
    opts = o(opts);
    var r = root('div', 'd-composer', opts);
    r.appendChild(pf(opts.pfAttrs, { size: 48, tone: 'you' }));
    var input = opts.input || el('input');
    input.classList.add('d-composer-in');
    if (!opts.input) {
      input.type = 'text';
      if (opts.placeholder) input.placeholder = opts.placeholder;
      input.setAttribute('aria-label', opts.label || 'Message');
    }
    r.appendChild(input);
    var send = opts.send;
    if (send) { send.classList.add('d-btn', 'is-teal', 'is-sq'); }
    else send = btn({ glyph: 'chevron-right', tone: 'teal', square: true, ariaLabel: 'Send' });
    r.appendChild(send);
    return { root: r, input: input, send: send };
  }
  function roster(items, tight) {
    var r = el('div', 'd-roster' + (tight ? ' is-tight' : ''));
    (items || []).forEach(function (it) { r.appendChild(ship(it.slug, 32, { foe: it.foe, dead: it.dead, skull: it.dead })); });
    return r;
  }

  // ── Fitting ─────────────────────────────────────────────────────────────
  /* A row that never wraps keeps whole items or none: from the first item
   * that would cross the row's edge on, every one is left out (display:
   * none). Call it again whenever the row or its items change. */
  function fitRow(box, keep) {
    if (!box) return;
    var full = false;
    Array.prototype.forEach.call(box.children, function (c) { c.style.display = ''; });
    var room = box.clientWidth;
    // `keep` (a child) is never left out: the rest give way around it.
    Array.prototype.forEach.call(box.children, function (c) {
      if (c === keep) return;
      if (full || c.offsetLeft - box.offsetLeft + c.offsetWidth > room) { full = true; c.style.display = 'none'; }
    });
  }
  /* A drawn timeline's captions: on each side of the line, captions that
   * would touch are eased apart, and one near either end is nudged inward,
   * so none runs past `box` (the timeline's panel body). Measured on screen
   * and written back in layout px, so it holds at the game's 2x and 4x. */
  function fitTimeline(box) {
    var b = box && box.getBoundingClientRect();
    if (!b || !b.width || !box.offsetWidth) return;
    var scale = b.width / box.offsetWidth;
    var gap = 4 * scale;
    ['you', 'them'].forEach(function (side) {
      var caps = Array.prototype.map.call(box.querySelectorAll('.d-tl-ev.is-' + side + ' > .d-tl-cap'), function (c) {
        c.style.translate = '';
        var r = c.getBoundingClientRect();
        return { cap: c, left: r.left, right: r.right, dx: 0 };
      }).sort(function (x, y) { return x.left - y.left; });
      for (var i = 1; i < caps.length; i++) {
        var p = caps[i - 1], q = caps[i], over = (p.right + p.dx + gap) - (q.left + q.dx);
        if (over > 0) { p.dx -= over / 2; q.dx += over / 2; }
      }
      caps.forEach(function (c) {
        if (c.right + c.dx > b.right) c.dx = b.right - c.right;
        if (c.left + c.dx < b.left) c.dx = b.left - c.left;
        if (Math.round(c.dx / scale)) c.cap.style.translate = Math.round(c.dx / scale) + 'px';
      });
    });
  }

  window.SimDeck = {
    el: el, sr: sr, glyph: glyph, sprite: sprite, ship: ship, pf: pf, led: led, hp: hp, chevs: chevs, brackets: brackets, vs: vs,
    panel: panel, sec: sec, rule: rule, screen: screen,
    cards: cards, structCard: structCard, seg: seg, rank: rank, battery: battery, mini: mini,
    tile: tile, reach: reach, fleet: fleet,
    hero: hero, facts: facts, key: key, weapon: weapon, guard: guard,
    btn: btn, iconBtn: iconBtn, tool: tool, launch: launch, menu: menu, bindMenu: bindMenu,
    ready: ready, mode: mode, pill: pill,
    modal: modal, modalOpen: modalOpen,
    stats: stats, timeline: timeline, verdict: verdict, alert: alert, lrow: lrow, ladder: ladder, msg: msg, composer: composer, roster: roster,
    fitRow: fitRow, fitTimeline: fitTimeline,
    AMBITS: AMBITS,
  };
})();
