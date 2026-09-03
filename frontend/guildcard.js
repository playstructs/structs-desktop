/* The guild card — one component for every place the app shows a guild.
 *
 * The player card's sibling: same frame, same readings, same doors, built
 * from `StructsPlayerCard.parts` so the two can never drift. Load it AFTER
 * playercard.js.
 *
 *   StructsGuildCard.card(g, opts)   the game's planet-card frame
 *   StructsGuildCard.chip(g, opts)   one inline line, for a guild named
 *                                    inside something else
 *
 * `g` is a plain description, already formatted:
 *
 *   id        '0-1'                             (required)
 *   name      'SN Corp'                         (defaults to "Guild <id>")
 *   tag       'SNC'                             shown as [SNC] before the name
 *   logo      'https://…/logo.png' | null       the guild's published mark; the
 *                                               guild glyph stands in when there
 *                                               is none or it does not load
 *   badge     { text: 'HOME', mod: 'warning' }  sui-badge; the relationship to you
 *   sub       'matrix.example'                  after the id, on the hint line
 *   readings  [{ value: '2,489', icon: 'sui-icon-players', title: 'Members' }]
 *
 * `opts`:
 *   actions   [{ icon: 'icon-link-out', title: 'Visit the guild site', onClick(ev) }]
 *   onClick   the card (or chip) was clicked; never fires for an action click
 *
 * Everything is built with textContent — guild names and logos are somebody
 * else's data.
 */
(function (root) {
  'use strict';

  function parts() {
    var pc = root.StructsPlayerCard;
    if (!pc || !pc.parts) throw new Error('guildcard.js needs playercard.js loaded first');
    return pc.parts;
  }
  function str(v) { return v == null ? '' : String(v); }
  function displayName(g) { return g.name != null && g.name !== '' ? String(g.name) : 'Guild ' + str(g.id); }

  /* The emblem: the guild's logo when it has one and it loads, otherwise the
   * game's guild glyph in the same frame. A logo the window cannot fetch (the
   * desktop CSP allows only bundled images) falls back the same way a missing
   * one does, so a card never shows a broken image. */
  function emblem(g, size) {
    var P = parts();
    var box = P.el('div', 'gc-emblem' + (size ? ' gc-' + size : ''));
    var glyph = P.icon((size === 'xs' ? 'sui-icon-md' : 'sui-icon-lg') + ' icon-guild');
    var logo = str(g.logo);
    if (/^(https?:)?\/\/|^[a-z0-9_./-]+$/i.test(logo) && !/^javascript:/i.test(logo)) {
      var img = P.el('img');
      img.alt = '';
      img.addEventListener('error', function () {
        if (img.parentNode) img.parentNode.replaceChild(glyph, img);
      });
      img.src = logo;
      box.appendChild(img);
    } else {
      box.appendChild(glyph);
    }
    return box;
  }

  function nameSpan(g) {
    var P = parts();
    var nm = P.el('span', 'pc-name');
    // Text nodes between the pieces: the layout gap is visual only, and the
    // copied or read-aloud text should still say "[SNC] SN Corp #0-1".
    if (g.tag) {
      nm.appendChild(P.el('span', 'gc-tag', '[' + str(g.tag) + ']'));
      nm.appendChild(document.createTextNode(' '));
    }
    nm.appendChild(P.el('span', 'pc-nm', displayName(g)));
    nm.title = (g.tag ? '[' + str(g.tag) + '] ' : '') + displayName(g);
    return nm;
  }

  function idSpan(g) {
    var P = parts();
    var s = P.el('span', 'pc-id', '#' + str(g.id));
    if (g.sub) s.appendChild(document.createTextNode(' · ' + str(g.sub)));
    return s;
  }

  function readings(g) {
    var P = parts();
    var box = P.el('div', 'pc-reads');
    (g.readings || []).forEach(function (r) { if (r) box.appendChild(P.reading(r)); });
    return box;
  }

  /* ── the planet-card frame ─────────────────────────────────────────── */
  function card(g, opts) {
    opts = opts || {};
    var P = parts();
    var node = P.el('div', 'sui-planet-card pc-card gc-card');
    node.setAttribute('data-guild-id', str(g.id));

    var head = P.el('div', 'sui-planet-card-header');
    var lab = P.el('div', 'sui-planet-card-header-label');
    var title = P.el('div', 'sui-planet-card-header-label-title');
    title.appendChild(nameSpan(g));
    title.appendChild(idSpan(g));
    lab.appendChild(title);
    head.appendChild(lab);
    var bd = P.badge(g.badge);
    if (bd) head.appendChild(bd);
    node.appendChild(head);

    var body = P.el('div', 'sui-planet-card-body');
    var content = P.el('div', 'sui-planet-card-body-content pc-body');
    content.appendChild(emblem(g));
    content.appendChild(readings(g));
    body.appendChild(content);
    var acts = P.actions(opts.actions);
    if (acts.childNodes.length) {
      var foot = P.el('div', 'pc-foot');
      foot.appendChild(acts);
      body.appendChild(foot);
    }
    node.appendChild(body);
    P.wireClick(node, opts);
    return node;
  }

  /* ── one inline line ───────────────────────────────────────────────── */
  function chip(g, opts) {
    opts = opts || {};
    var P = parts();
    var node = P.el(opts.onClick ? 'a' : 'span', 'gc-chip');
    if (opts.onClick) node.href = 'javascript:void(0)';
    node.setAttribute('data-guild-id', str(g.id));
    node.appendChild(emblem(g, 'xs'));
    node.appendChild(nameSpan(g));
    node.appendChild(document.createTextNode(' '));
    node.appendChild(idSpan(g));
    P.wireClick(node, opts);
    return node;
  }

  root.StructsGuildCard = {
    emblem: emblem,
    card: card,
    chip: chip,
  };
})(typeof window !== 'undefined' ? window : globalThis);
