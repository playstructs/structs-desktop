/* The provider card — one component for every place the app shows an offer
 * of energy capacity.
 *
 * Third of the family (playercard.js, guildcard.js): same frame, same
 * readings, same doors, built from `StructsPlayerCard.parts`. Load it after
 * playercard.js; its emblem frame comes from guildcard.css.
 *
 *   StructsProviderCard.card(p, opts)   the game's planet-card frame
 *   StructsProviderCard.chip(p, opts)   one inline line
 *
 * `p` is a plain description, already formatted:
 *
 *   id          '10-1'                                (required)
 *   substation  '4-4'                                 where the capacity comes from
 *   policy      'openMarket' | 'guildMarket' | 'closedMarket'   drawn as the badge
 *   rate        { value: '1', denomLabel: 'ack', denomIcon: null }
 *                                                     price per W per block; the
 *                                                     alpha glyph when it is alpha,
 *                                                     the token's own name otherwise
 *   capacity    { min: '1KW', max: '1GW' }
 *   duration    { min: '9m', max: '61d', blocks: '100 – 1M blocks' }   time, blocks on hover
 *   owner       { id: '1-170', name: 'TRACINGVIOLET', tag: 'SNC', pfp: '{…}' }
 *
 * `opts`:
 *   actions   [{ icon: 'icon-transfers', title: 'Rent capacity', onClick(ev) }]
 *   onClick   the card (or chip) was clicked; never fires for an action click
 *   onOwner   the owner line was clicked
 *
 * Everything is built with textContent — owners and denoms are other
 * people's data.
 */
(function (root) {
  'use strict';

  var POLICY = {
    openMarket: { text: 'OPEN', mod: 'default' },
    guildMarket: { text: 'GUILD', mod: 'warning' },
    closedMarket: { text: 'CLOSED', mod: 'destructive' },
  };

  function parts() {
    var pc = root.StructsPlayerCard;
    if (!pc || !pc.parts) throw new Error('providercard.js needs playercard.js loaded first');
    return pc.parts;
  }
  function str(v) { return v == null ? '' : String(v); }
  function unit(text) { return parts().el('span', 'xp-unit', text); }

  function emblem(size) {
    var P = parts();
    var box = P.el('div', 'gc-emblem xp-emblem' + (size ? ' gc-' + size : ''));
    box.appendChild(P.icon((size === 'xs' ? 'sui-icon-md' : 'sui-icon-lg') + ' icon-transfers'));
    return box;
  }

  // "1 ack / W / blk" — the alpha glyph stands in for the word when it is alpha.
  function rateReading(p) {
    var P = parts();
    var r = p.rate || {};
    var s = P.el('span', 'pc-res xp-rate');
    s.title = 'Price per W per block';
    // Text nodes between the pieces so the copied text reads "1 ack / W / blk".
    s.appendChild(document.createTextNode(str(r.value) + ' '));
    if (r.denomIcon) s.appendChild(P.icon(r.denomIcon));
    else if (r.denomLabel) { s.appendChild(unit(str(r.denomLabel))); s.appendChild(document.createTextNode(' ')); }
    s.appendChild(unit('/ W / blk'));
    return s;
  }

  function rangeReading(range, iconCls, title) {
    var P = parts();
    if (!range) return null;
    var s = P.el('span', 'pc-res xp-range');
    s.title = title;
    s.appendChild(document.createTextNode(str(range.min) + ' '));
    s.appendChild(P.el('span', 'xp-dash', '–'));
    s.appendChild(document.createTextNode(' ' + str(range.max)));
    s.appendChild(P.icon(iconCls));
    return s;
  }

  function readings(p) {
    var P = parts();
    var box = P.el('div', 'pc-reads');
    if (p.rate) box.appendChild(rateReading(p));
    var cap = rangeReading(p.capacity, 'sui-icon-energy', 'Capacity on offer');
    if (cap) box.appendChild(cap);
    var dur = rangeReading(p.duration, 'sui-icon-md icon-in-progress',
      'Agreement length' + (p.duration && p.duration.blocks ? ': ' + str(p.duration.blocks) : ''));
    if (dur) box.appendChild(dur);
    return box;
  }

  function policyBadge(p) {
    var pol = POLICY[p.policy];
    return pol ? parts().badge(pol) : null;
  }

  // The owner, as a small player line: portrait, [TAG] name, #id.
  function ownerLine(p, opts) {
    var P = parts();
    var o = p.owner;
    if (!o || !o.id) return null;
    var line = P.el(opts.onOwner ? 'a' : 'span', 'xp-owner');
    if (opts.onOwner) line.href = 'javascript:void(0)';
    line.setAttribute('data-player-id', str(o.id));
    if (root.StructsPlayerCard.portrait) line.appendChild(root.StructsPlayerCard.portrait(o.pfp));
    var nm = P.el('span', 'pc-name');
    if (o.tag) {
      nm.appendChild(P.el('span', 'gc-tag', '[' + str(o.tag) + ']'));
      nm.appendChild(document.createTextNode(' '));
    }
    nm.appendChild(P.el('span', 'pc-nm', o.name != null && o.name !== '' ? str(o.name) : str(o.id)));
    line.appendChild(nm);
    line.appendChild(document.createTextNode(' '));
    line.appendChild(P.el('span', 'pc-id', '#' + str(o.id)));
    line.title = 'Offered by ' + (o.name || o.id);
    if (opts.onOwner) {
      line.classList.add('pc-mod-clickable');
      line.addEventListener('click', function (ev) { ev.stopPropagation(); opts.onOwner(ev, line); });
    }
    return line;
  }

  /* ── the planet-card frame ─────────────────────────────────────────── */
  function card(p, opts) {
    opts = opts || {};
    var P = parts();
    var node = P.el('div', 'sui-planet-card pc-card xp-card');
    node.setAttribute('data-provider-id', str(p.id));

    var head = P.el('div', 'sui-planet-card-header');
    var lab = P.el('div', 'sui-planet-card-header-label');
    var title = P.el('div', 'sui-planet-card-header-label-title');
    var nm = P.el('span', 'pc-name');
    nm.appendChild(P.el('span', 'pc-nm', 'Provider ' + str(p.id)));
    title.appendChild(nm);
    var idl = P.el('span', 'pc-id', '#' + str(p.id));
    if (p.substation) {
      idl.appendChild(document.createTextNode(' · ' + str(p.substation)));
      idl.title = 'Substation ' + str(p.substation);
    }
    title.appendChild(idl);
    lab.appendChild(title);
    head.appendChild(lab);
    var bd = policyBadge(p);
    if (bd) head.appendChild(bd);
    node.appendChild(head);

    var body = P.el('div', 'sui-planet-card-body');
    var content = P.el('div', 'sui-planet-card-body-content pc-body');
    content.appendChild(emblem());
    content.appendChild(readings(p));
    body.appendChild(content);

    var owner = ownerLine(p, opts);
    var acts = P.actions(opts.actions);
    if (owner || acts.childNodes.length) {
      var foot = P.el('div', 'pc-foot');
      if (owner) foot.appendChild(owner);
      if (acts.childNodes.length) foot.appendChild(acts);
      body.appendChild(foot);
    }
    node.appendChild(body);
    P.wireClick(node, opts);
    return node;
  }

  /* ── one inline line: price, id, policy ────────────────────────────── */
  function chip(p, opts) {
    opts = opts || {};
    var P = parts();
    var node = P.el(opts.onClick ? 'a' : 'span', 'gc-chip xp-chip');
    if (opts.onClick) node.href = 'javascript:void(0)';
    node.setAttribute('data-provider-id', str(p.id));
    node.appendChild(emblem('xs'));
    var r = p.rate || {};
    var nm = P.el('span', 'pc-name');
    nm.appendChild(P.el('span', 'pc-nm',
      str(r.value) + (r.denomLabel ? ' ' + str(r.denomLabel) : '') + ' / W / blk'));
    node.appendChild(nm);
    node.appendChild(document.createTextNode(' '));
    node.appendChild(P.el('span', 'pc-id', '#' + str(p.id)));
    var bd = policyBadge(p);
    if (bd) { node.appendChild(document.createTextNode(' ')); node.appendChild(bd); }
    P.wireClick(node, opts);
    return node;
  }

  root.StructsProviderCard = {
    POLICY: POLICY,
    card: card,
    chip: chip,
  };
})(typeof window !== 'undefined' ? window : globalThis);
