// Team Ops Command Center — core runtime: hash router, per-page refresh
// scheduler, shared helpers, EVENT FEED, agent-UI directives, and the OPS page.
// Page renderers (fleet/energy/work/config/map) live in board-pages.js.
//
// This file MUST stay at the frontend ROOT: scripts/sync.sh deletes and
// rebuilds frontend/js/ from the webapp submodule, but preserves root-level
// files (index.html, structs-config.js, board.html — and these).
(function () {
  'use strict';

  var Board = window.Board = {
    T: null,                 // window.__TAURI__ once available
    pages: {},               // name -> { onEnter?, refresh?, cadenceMs?, lastRun }
    current: 'ops',          // the PAGE (div + renderer) currently visible
    area: 'command',         // the top-level area in the tab bar
    section: 'overview',     // the sub-section within it
    helpers: {},
  };

  // ── The page manifest ───────────────────────────────────────────────────
  // The console grew one tab per feature until nine of them sat in a bar that
  // no longer said what any of them were for. These are the five things the
  // operator actually does; every old tab is a section inside one of them.
  //
  // ONE list. The tab bar, the sub-nav, which page div is visible and the
  // router all read it — previously three parallel lists (PAGE_NAMES, the
  // <a data-page> markup, the <div id="page-*"> containers) drifted apart.
  //
  // `page` is the renderer/div key (unchanged, so registerPage keeps working);
  // `view` is passed to that page's onEnter for pages that hold several
  // sections in one body (War, Config).
  var AREAS = [
    // Stream lives here, not under System: it is "what is happening in the
    // world right now", which is the same question Overview answers — and as
    // System's seventh entry it was effectively buried.
    { key: 'command', label: 'Command', sections: [
      { key: 'overview', label: 'Overview', page: 'ops' },
      { key: 'stream', label: 'Stream', page: 'grass' },
      // Whole-game stats. `hidden` keeps it out of the sub-nav: it is a
      // pop-out-only page (opened from the game's Debug tab), not a Team Ops
      // section — but the router still needs an area/section to resolve the
      // solo view, and PAGE_NAMES needs the page div registered.
      { key: 'universe', label: 'Universe', page: 'gamestats', hidden: true },
    ] },
    // "Armada", not "Fleet": a fleet is a specific game entity (9-xxx, the
    // thing that moves between planets). This is our roster of players.
    // No Map section: a roster row now opens the SPECTATOR window on that
    // player's planet or fleet. The old page round-tripped `mcp_render_map`
    // through the game's own canvas renderer — ~11 seconds for a still image,
    // and it briefly commandeered the visible map container to do it. The
    // spectator draws the same board itself, live, in its own window, several
    // at once, without touching the game view.
    { key: 'armada', label: 'Armada', sections: [
      { key: 'roster', label: 'Roster', page: 'armada' },
      { key: 'squads', label: 'Squads', page: 'config', view: 'appearance' },
      // Behaviour profiles sit under Armada rather than Config: they describe
      // what a squad DOES, which is a roster decision, not an app setting.
      { key: 'profiles', label: 'Profiles', page: 'config', view: 'profiles' },
    ] },
    // Power splits along the line the game itself draws: an infusion CREATES
    // capacity (staking Alpha into a reactor), an allocation ROUTES capacity
    // you already have. They were one page while infusions had no UI at all;
    // as soon as infusions got controls, the combined page was two unrelated
    // grids of numbers under one heading.
    { key: 'industry', label: 'Industry', sections: [
      { key: 'production', label: 'Production', page: 'energy', view: 'production' },
      { key: 'distribution', label: 'Distribution', page: 'energy', view: 'distribution' },
      { key: 'work', label: 'Work', page: 'work' },
      { key: 'inventory', label: 'Inventory', page: 'inventory' },
      { key: 'transactions', label: 'Transactions', page: 'tx' },
    ] },
    { key: 'war', label: 'War', sections: [
      { key: 'doctrine', label: 'Doctrine', page: 'war', view: 'doctrine' },
      { key: 'targets', label: 'Targets', page: 'war', view: 'targets' },
      { key: 'lists', label: 'Lists', page: 'war', view: 'lists' },
      { key: 'incidents', label: 'Incidents', page: 'war', view: 'incidents' },
      { key: 'raids', label: 'Live Raids', page: 'raids' },
    ] },
    { key: 'system', label: 'System', sections: [
      { key: 'doctrine', label: 'Doctrine', page: 'config', view: 'doctrine' },
      { key: 'loops', label: 'Loops', page: 'config', view: 'loops' },
      { key: 'policies', label: 'Policies', page: 'config', view: 'policies' },
      { key: 'engine', label: 'Engine', page: 'config', view: 'engine' },
      { key: 'access', label: 'Access', page: 'config', view: 'access' },
      { key: 'diagnostics', label: 'Diagnostics', page: 'diagnostics' },
    ] },
  ];
  Board.AREAS = AREAS;

  // Every page div the manifest can show — derived, never hand-listed.
  var PAGE_NAMES = (function () {
    var seen = {}, out = [];
    AREAS.forEach(function (a) {
      a.sections.forEach(function (s) {
        if (!seen[s.page]) { seen[s.page] = 1; out.push(s.page); }
      });
    });
    return out;
  })();

  // Old single-word routes stay live — bookmarks, the agent's own deep links
  // (`#/map?p=…`) and anything the Rust side emits must not 404.
  var LEGACY_ROUTES = {
    ops: 'command/overview', fleet: 'armada/roster', armada: 'armada/roster',
    // The Map page is gone; its bookmarks and any `#/map?p=…` the Rust side
    // still emits land on the Roster, which is where the spectator is opened
    // from now. A dead route would 404 an old link for no reason.
    map: 'armada/roster', energy: 'industry/distribution', work: 'industry/work',
    tx: 'industry/transactions', grass: 'command/stream', config: 'system/loops',
  };
  // Sections that have moved between areas. Same job as LEGACY_ROUTES, one
  // level down — without it `#/system/stream` would silently land on
  // System's first section instead of the page you bookmarked.
  // `industry/power` is where every existing bookmark and the Rust side's own
  // deep links point; allocations are what that page was used FOR, so it lands
  // on Distribution rather than on the new Production section.
  var LEGACY_SECTIONS = {
    'system/stream': 'command/stream',
    'industry/power': 'industry/distribution',
  };

  // ── Pop-out mode ────────────────────────────────────────────────────────
  // `board.html?view=stream` runs this SAME page as a standalone window
  // showing one section and nothing else. One renderer, one set of event
  // listeners — a second implementation of the stream would drift immediately.
  var SOLO_VIEWS = { stream: 'command/stream', gamestats: 'command/universe' };
  function soloView() {
    var m = /[?&]view=([a-z]+)/.exec(location.search || '');
    return (m && SOLO_VIEWS[m[1]]) ? m[1] : null;
  }
  Board.solo = soloView();

  function findArea(key) {
    for (var i = 0; i < AREAS.length; i++) if (AREAS[i].key === key) return AREAS[i];
    return null;
  }

  function findSection(area, key) {
    for (var i = 0; i < area.sections.length; i++) {
      if (area.sections[i].key === key) return area.sections[i];
    }
    return area.sections[0];
  }

  Board.registerPage = function (name, def) {
    def = def || {};
    def.lastRun = 0;
    Board.pages[name] = def;
  };

  // ── Shared helpers (mirror the Rust irow/card look) ──────────────────────
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  // Label/value row inside a sui-data-card-body. `value` may be a node or string.
  function row(label, value, iconCls) {
    var r = el('div', 'sui-data-card-row');
    var l = el('span');
    if (iconCls) {
      var ic = el('i', iconCls.indexOf('sui-icon-') === 0 ? 'sui-icon ' + iconCls + ' sui-icon-sm' : iconCls);
      l.appendChild(ic);
      l.appendChild(document.createTextNode(' '));
    }
    l.appendChild(document.createTextNode(label));
    var v = el('span', 'ops-val');
    if (value && value.nodeType) v.appendChild(value); else v.textContent = value == null ? '' : String(value);
    r.appendChild(l); r.appendChild(v);
    return r;
  }
  function card(title, bodyNode) {
    var c = el('div', 'sui-data-card sui-theme-player');
    c.appendChild(el('div', 'sui-data-card-header sui-text-header', title));
    var b = el('div', 'sui-data-card-body sui-mod-spacing-xl');
    b.appendChild(bodyNode);
    c.appendChild(b);
    return c;
  }
  function badge(text, mod) {
    return el('span', 'sui-badge' + (mod ? ' sui-mod-' + mod : ''), text);
  }
  // Tiny charge/energy meter: n-of-total filled cells (scoped .fbat CSS —
  // lighter than sui-battery's PNG chunks at 12px row height).
  function battery(filled, total) {
    var b = el('span', 'fbat');
    for (var i = 0; i < total; i++) {
      b.appendChild(el('i', i < filled ? 'on' : ''));
    }
    return b;
  }
  // Progress bar 0..1 (scoped .bar CSS).
  function progressBar(frac) {
    var wrap = el('div', 'bar');
    var fill = el('i');
    fill.style.width = Math.max(0, Math.min(1, frac || 0)) * 100 + '%';
    wrap.appendChild(fill);
    return wrap;
  }
  function fmtNum(n) {
    if (n == null || isNaN(n)) return '—';
    var a = Math.abs(n);
    if (a >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (a >= 1e3) return (n / 1e3).toFixed(1) + 'k';
    if (a >= 100) return String(Math.round(n));
    return (Math.round(n * 10) / 10).toString();
  }
  // Full integer, thousands-separated — for block heights and anything where
  // abbreviation destroys the meaning.
  function fmtInt(n) {
    if (n == null || isNaN(n)) return '—';
    return Math.round(Number(n)).toLocaleString();
  }
  // ── The game's unit ladders ───────────────────────────────────────────────
  // One transcription of the server's UNIT_DISPLAY_FORMAT (mirrored in the
  // webapp's own `formatUnit`, structs-config.js): the unit is chosen by the
  // INTEGER DIGIT-LENGTH of the raw value, not by magnitude thresholds, and the
  // postfix is written the way the game writes it (`KW`, `Kg`, no space) so a
  // number on this board is character-for-character the number in the HUD.
  //
  // Each ladder is `[minDigits, divisor, postfix]`, longest-first at read time.
  // A scale is also addressable BY NAME (fmtIn / SCALES) so an input can offer
  // "which unit am I typing in", which is the only honest way to ask someone
  // for a quantity that spans twelve orders of magnitude.
  var SCALES = {
    // milliwatts in
    power: [[16, 1e18, 'TW'], [10, 1e9, 'MW'], [6, 1e6, 'KW'], [3, 1e3, 'W'], [0, 1, 'mW']],
    // ualpha in (1 g Alpha = 1e6 ualpha — "Alpha" and "gram" are the same unit)
    alpha: [[16, 1e18, 'Tg'], [10, 1e9, 'Kg'], [6, 1e6, 'g'], [3, 1e3, 'mg'], [0, 1, 'μg']],
    // grams in
    ore: [[12, 1e12, 'Tg'], [4, 1e3, 'Kg'], [0, 1, 'g']],
  };
  // Trim to at most 2 decimals without leaving a trailing ".0"/".00" — exactly
  // what the game's `toFixed(2).replace(/\.?0+$/,'')` does.
  function trim2(v) {
    return v.toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
  }
  function stepFor(raw, ladder) {
    var len = String(Math.abs(Math.trunc(Number(raw)))).length;
    for (var i = 0; i < ladder.length; i++) {
      if (len >= ladder[i][0]) return ladder[i];
    }
    return ladder[ladder.length - 1];
  }
  function fmtScale(raw, kind) {
    if (raw == null || isNaN(raw)) return '—';
    var step = stepFor(raw, SCALES[kind]);
    return trim2(Number(raw) / step[1]) + step[2];
  }
  // Energy: raw value in MILLIWATTS.
  function fmtWatts(mw) { return fmtScale(mw, 'power'); }
  // Alpha: raw value in ualpha (micrograms).
  function fmtAlpha(ualpha) { return fmtScale(ualpha, 'alpha'); }
  // Ore: raw value in grams.
  function fmtOre(g) { return fmtScale(g, 'ore'); }
  // Format a whole SET of values on ONE shared unit — the unit the largest of
  // them would pick. A strip of tiles meant to be compared against each other
  // ("59 KW / 6.53 KW / 0 mW / 52.47 KW") is unreadable when every tile picks
  // its own scale; the comparison is the whole point of putting them in a row.
  // Returns { fmt(raw) -> "59", unit: "KW" }.
  function scaleSet(values, kind) {
    var max = 0;
    (values || []).forEach(function (v) {
      if (v != null && !isNaN(v) && Math.abs(v) > max) max = Math.abs(v);
    });
    var step = stepFor(max, SCALES[kind]);
    return {
      unit: step[2],
      div: step[1],
      fmt: function (raw) {
        if (raw == null || isNaN(raw)) return '—';
        return trim2(Number(raw) / step[1]) + step[2];
      },
    };
  }
  // The units an operator may type a quantity IN, largest first — the option
  // list behind every amount field on this board.
  function unitOptions(kind) {
    return SCALES[kind].map(function (s) { return { value: s[2], label: s[2], div: s[1] }; });
  }
  function unitDivisor(kind, unit) {
    var l = SCALES[kind];
    for (var i = 0; i < l.length; i++) if (l[i][2] === unit) return l[i][1];
    return 1;
  }
  function ago(ms) {
    if (!ms) return '—';
    var s = Math.max(0, (Date.now() - ms) / 1000);
    if (s < 90) return Math.round(s) + 's';
    if (s < 5400) return Math.round(s / 60) + 'm';
    return Math.round(s / 3600) + 'h';
  }
  function alertLine(text, iconCls) {
    var a = el('div', 'sui-message-inline-alert');
    a.appendChild(el('i', iconCls || 'icon-info'));
    var t = el('span', 'sui-message-inline-alert-text');
    t.textContent = ' ' + text;
    a.appendChild(t);
    return a;
  }
  // Resolve an icon name to the right class string: PNG sui-icon-* glyphs need
  // the `sui-icon` base + a size; structicon `icon-*` glyphs stand alone.
  function iconClass(name, size) {
    if (!name) return '';
    return name.indexOf('sui-icon-') === 0
      ? 'sui-icon ' + name + ' ' + (size || 'sui-icon-sm')
      : name;
  }
  // Compose the game's 5-layer profile portrait from on-chain attributes
  // (`{head,neck,body,arms,background}`), painted back-to-front exactly like the
  // webapp's PfpViewerComponent. Falls back to the placeholder when a player has
  // no portrait yet. `fallbackIcon` (a sui-icon name) is used only if even the
  // placeholder is unwanted — normally omit it. Returns a portrait node.
  var PFP_LAYERS = ['background', 'arms', 'body', 'neck', 'head'];
  function pfpPortrait(attrsJson) {
    var box = el('div', 'sui-result-row-portrait');
    var img = el('div', 'sui-result-row-portrait-image pfp-frame');
    var pfp = null;
    if (attrsJson) { try { pfp = JSON.parse(attrsJson); } catch (e) { pfp = null; } }
    if (pfp && typeof pfp === 'object' && pfp.head != null) {
      PFP_LAYERS.forEach(function (part) {
        var idx = pfp[part];
        if (idx == null) return;
        var im = el('img', 'pfp-viewer-layer');
        im.src = 'img/pfp/' + part + '/pfp_' + part + '_' + idx + '.png';
        im.alt = '';
        img.appendChild(im);
      });
    } else {
      var ph = el('img', 'pfp-viewer-layer');
      ph.src = 'img/portrait-placeholder.png';
      ph.alt = '';
      img.appendChild(ph);
    }
    box.appendChild(img);
    return box;
  }
  // ── Native SUI result-row builders (the game's raid-scan / roster idiom) ──
  // Header-less: each row self-describes via a left identity section and a
  // right row of `sui-resource` chips (value + icon). No column headers to
  // misalign; reflows on the narrow board window.
  function resultTable() { return el('div', 'sui-result-rows sui-result-table'); }
  // A single value+icon chip. `value` may be a node or string; icon optional.
  function resource(value, iconName, extraCls) {
    var d = el('div', 'sui-resource' + (extraCls ? ' ' + extraCls : ''));
    var v = el('span');
    if (value && value.nodeType) v.appendChild(value); else v.textContent = value == null ? '' : String(value);
    d.appendChild(v);
    if (iconName) d.appendChild(el('i', iconClass(iconName)));
    return d;
  }
  // Compact stat: big value over a small ExtremeHazard label. Used in roster
  // rows, the health strip and anywhere a number needs naming without a
  // full label/value row's horizontal budget.
  //
  // `label` may be an ARRAY of two strings: the term, then what the figure
  // decides. That second line is how a genuinely confusable pair (allocatable
  // vs available) gets defined ON the number instead of in a paragraph under
  // the card \u2014 it stays with the value at every window width.
  function statTile(label, value, iconName, cls) {
    var t = el('div', 'fstat' + (cls ? ' ' + cls : ''));
    var v = el('div', 'fstat-v');
    if (value && value.nodeType) v.appendChild(value);
    else v.appendChild(document.createTextNode(value == null ? '\u2014' : String(value)));
    if (iconName) v.appendChild(el('i', iconClass(iconName)));
    t.appendChild(v);
    if (Array.isArray(label)) {
      t.appendChild(el('div', 'fstat-l', label[0]));
      if (label[1]) t.appendChild(el('div', 'fstat-l fstat-l2', label[1]));
    } else {
      t.appendChild(el('div', 'fstat-l', label));
    }
    return t;
  }
  // Build one sui-result-row. opts: { lead?(node, e.g. checkbox), icon?(portrait
  // glyph), title(str|node), subtitle?(str|node), chips?([node]), action?(node),
  // onClick? }.
  function resultRow(opts) {
    var r = el('div', 'sui-result-row');
    var left = el('div', 'sui-result-row-left-section');
    if (opts.lead) left.appendChild(opts.lead);
    // `portrait` (a prebuilt node, e.g. from pfpPortrait) wins over `icon`
    // (a sui-icon glyph framed as a portrait).
    if (opts.portrait) {
      left.appendChild(opts.portrait);
    } else if (opts.icon) {
      var port = el('div', 'sui-result-row-portrait');
      var pin = el('div', 'sui-result-row-portrait-icon');
      pin.appendChild(el('i', iconClass(opts.icon, 'sui-icon-md')));
      port.appendChild(pin);
      left.appendChild(port);
    }
    var info = el('div', 'sui-result-row-player-info');
    var lbl = el('div', 'sui-text-label-block');
    if (opts.title && opts.title.nodeType) lbl.appendChild(opts.title);
    else lbl.appendChild(document.createTextNode(opts.title == null ? '' : String(opts.title)));
    if (opts.subtitle != null) {
      lbl.appendChild(el('br'));
      var hint = el('span', 'sui-text-hint');
      if (opts.subtitle.nodeType) hint.appendChild(opts.subtitle); else hint.textContent = String(opts.subtitle);
      lbl.appendChild(hint);
    }
    info.appendChild(lbl);
    left.appendChild(info);
    r.appendChild(left);
    var right = el('div', 'sui-result-row-right-section');
    var res = el('div', 'sui-result-row-resources');
    (opts.chips || []).forEach(function (c) { if (c) res.appendChild(c); });
    right.appendChild(res);
    if (opts.action) right.appendChild(opts.action);
    r.appendChild(right);
    if (opts.onClick) {
      r.classList.add('is-clickable');
      r.style.cursor = 'pointer';
      r.addEventListener('click', function (ev) {
        // A row can be both clickable (opens detail) and carry action
        // controls. Without this, clicking Send also opened the detail
        // drawer, which then rendered over the form you asked for.
        if (opts.action && opts.action.contains(ev.target)) return;
        if (opts.lead && opts.lead.contains(ev.target)) return;
        opts.onClick(ev);
      });
    }
    return r;
  }
  // ── Shared sorting ──────────────────────────────────────────────────────
  // sortControl builds a `<select>` of {key,label} + a caret asc/desc toggle,
  // mutating `state` ({key,dir}) and calling onChange. sortBy returns a sorted
  // copy using per-key accessors. Used identically by Armada / Energy / Work.
  function sortControl(keys, state, onChange) {
    var wrap = el('div', null);
    wrap.style.cssText = 'display:flex;gap:8px;align-items:center;';
    var sel = el('select', 'sui-input-text');
    keys.forEach(function (k, i) {
      var op = el('option', null, (i === 0 ? 'sort: ' : '') + k.label);
      op.value = k.key;
      if (k.key === state.key) op.selected = true;
      sel.appendChild(op);
    });
    sel.addEventListener('change', function () { state.key = sel.value; onChange(); });
    var dir = el('a', 'ops-refresh-btn'); dir.href = 'javascript:void(0)';
    var di = el('i', state.dir > 0 ? 'icon-caret-down' : 'icon-caret-up');
    dir.appendChild(di);
    dir.addEventListener('click', function () {
      state.dir = -state.dir;
      di.className = state.dir > 0 ? 'icon-caret-down' : 'icon-caret-up';
      onChange();
    });
    wrap.appendChild(sel); wrap.appendChild(dir);
    return wrap;
  }
  function sortBy(rows, state, accessors) {
    var acc = accessors[state.key] || function () { return 0; };
    var d = state.dir;
    return rows.slice().sort(function (a, b) {
      var va = acc(a), vb = acc(b);
      if (va < vb) return -d;
      if (va > vb) return d;
      return 0;
    });
  }
  // ── Native SUI form controls ─────────────────────────────────────────────
  // The game's own checkbox/stepper/select markup, so config surfaces look like
  // the rest of the client instead of raw browser widgets. Each returns a node
  // and calls `onChange(value)`; none of them hold state.
  function checkbox(checked, labelText, onChange) {
    // A DIV, matching SUI's documented markup. It must not be a <span>:
    // `label.sui-input-text span` (sui.css:1974) styles *any* span inside the
    // field wrapper as the field's label — a span container was inheriting
    // display:flex and a 32px min-height and blowing the control out to ~106px.
    var c = el('div', 'sui-checkbox-container');
    var box = el('input', 'sui-checkbox');
    box.type = 'checkbox';
    box.checked = !!checked;
    var disp = el('span', 'sui-checkbox-display');
    var lab = el('label');
    if (labelText != null) lab.appendChild(document.createTextNode(String(labelText)));
    if (labelText != null) c.classList.add('has-label');
    box.addEventListener('change', function () { onChange(box.checked); });
    // These often sit inside a row that opens an editor on click; toggling the
    // switch must not also open it.
    c.addEventListener('click', function (e) { e.stopPropagation(); });
    // The display is a sibling styled by `:checked ~ .sui-checkbox-display`, so
    // the input must come first and the label last.
    c.appendChild(box); c.appendChild(disp); c.appendChild(lab);
    return c;
  }
  // Numeric stepper. `opts`: {min,max,step,width}.
  //
  // Markup follows SUI's contract exactly — `sui-screen-btn sui-mod-secondary`
  // buttons carrying icon-subtract / icon-add, and the buttons as the input's
  // literal previous/next siblings, because that is how SUIInputStepper finds
  // them. We wire the behaviour ourselves rather than using that module: it
  // binds each input once during autoInitAll, and every stepper on this board
  // is created long after page load. Disabling the buttons at min/max is the
  // one thing it does that we'd otherwise lose, so it's reproduced here.
  function stepper(value, opts, onChange) {
    opts = opts || {};
    var w = el('span', 'sui-input-stepper');
    var input = el('input');
    input.type = 'number';
    input.value = value == null ? '' : value;
    if (opts.min != null) input.min = opts.min;
    if (opts.max != null) input.max = opts.max;
    input.step = opts.step == null ? 1 : opts.step;
    if (opts.width) input.style.width = opts.width;

    function stepBtn(iconName) {
      var b = el('button', 'sui-screen-btn sui-mod-secondary');
      b.type = 'button';
      b.appendChild(el('i', 'sui-icon sui-icon-md ' + iconName));
      return b;
    }
    var down = stepBtn('icon-subtract');
    var up = stepBtn('icon-add');

    function syncDisabled() {
      var n = Number(input.value);
      down.disabled = opts.min != null && !isNaN(n) && n <= Number(opts.min);
      up.disabled = opts.max != null && !isNaN(n) && n >= Number(opts.max);
    }
    function commit(v) {
      var n = Number(v);
      if (isNaN(n)) return;
      if (opts.min != null) n = Math.max(opts.min, n);
      if (opts.max != null) n = Math.min(opts.max, n);
      // Float steps accumulate noise (0.1+0.2); round to the step's precision.
      var dp = String(input.step).indexOf('.') >= 0 ? String(input.step).split('.')[1].length : 0;
      n = Number(n.toFixed(dp));
      input.value = n;
      syncDisabled();
      onChange(n);
    }
    down.addEventListener('click', function () { commit((Number(input.value) || 0) - Number(input.step || 1)); });
    up.addEventListener('click', function () { commit((Number(input.value) || 0) + Number(input.step || 1)); });
    input.addEventListener('change', function () { commit(input.value); });

    w.appendChild(down); w.appendChild(input); w.appendChild(up);
    syncDisabled();
    return w;
  }
  // SUI styles the BARE `select` element (sui.css:1937) — no class. A
  // `.sui-input-text` class here would style nothing; the label wrapper from
  // field() is what carries that class.
  function selectBox(value, options, onChange) {
    var s = el('select');
    (options || []).forEach(function (o) {
      var val = (o && o.value != null) ? o.value : o;
      var lbl = (o && o.label != null) ? o.label : o;
      var op = el('option', null, String(lbl));
      op.value = val;
      if (val === value) op.selected = true;
      s.appendChild(op);
    });
    s.addEventListener('change', function () { onChange(s.value); });
    return s;
  }
  // Likewise: SUI styles `label.sui-input-text input[type=text]`, a DESCENDANT
  // selector, so the input must sit inside field()'s label wrapper and carries
  // no class of its own.
  function textBox(value, placeholder, onChange) {
    var i = el('input');
    i.type = 'text';
    i.value = value == null ? '' : value;
    if (placeholder) i.placeholder = placeholder;
    i.addEventListener('change', function () { onChange(i.value); });
    return i;
  }
  // A secondary nav strip — the same component as the board's own tab bar, so
  // a page that needs sub-sections reads as native rather than bespoke.
  // `items`: [{key,label}]. Returns a node; `onPick(key)` fires on click.
  // `href(key)` makes the strip navigate for real (routed sub-sections);
  // omit it and the strip is a local state switch driven by `onPick`.
  function navStrip(items, activeKey, onPick, href) {
    var wrap = el('div', 'sui-screen sui-screen-full-width subnav');
    var bar = el('div', 'sui-screen-nav');
    var list = el('div', 'sui-screen-nav-items');
    items.forEach(function (it) {
      var a = el('a', 'sui-screen-nav-item' + (it.key === activeKey ? ' sui-mod-active' : ''));
      a.href = href ? href(it.key) : 'javascript:void(0)';
      a.textContent = it.label;
      if (onPick) a.addEventListener('click', function () { onPick(it.key); });
      list.appendChild(a);
    });
    bar.appendChild(list);
    wrap.appendChild(bar);
    return wrap;
  }
  // One labelled control, built the way the game builds them: `label.sui-input-text`
  // is SUI's universal field wrapper — its <span> labels a stepper, a select or
  // even a nested checkbox, not just a text input (see the webapp's ScanViewModel).
  //
  // `hint` becomes a press-and-hold tooltip on a small secondary tip icon
  // rather than a permanent grey line under the label — SUITooltip delegates
  // from document.body, so this works on content rendered at any time. Each
  // trigger needs its own id and a positioned parent, which the <span> provides.
  var fieldSeq = 0;
  function field(label, controlNode, hint) {
    var wrap = el('label', 'sui-input-text cfg-field');
    var cap = el('span');
    cap.appendChild(document.createTextNode(label));
    if (hint) {
      cap.appendChild(document.createTextNode(' '));
      var tip = el('a', 'sui-text-secondary');
      tip.id = 'cfg-tip-' + (++fieldSeq);
      tip.href = 'javascript:void(0)';
      tip.setAttribute('data-sui-tooltip', hint);
      tip.appendChild(el('i', 'sui-icon icon-tip'));
      cap.appendChild(tip);
    }
    wrap.appendChild(cap);
    wrap.appendChild(controlNode);
    return wrap;
  }

  // ── Amount field ─────────────────────────────────────────────────────────
  // A quantity the operator TYPES, in a unit they choose. Every amount on this
  // board spans a dozen orders of magnitude (μg→Tg, mW→TW), so a field fixed to
  // one display unit forces a mental 10^n conversion on the one form where
  // getting it wrong costs real money or browns out the grid.
  //
  // `opts`: { kind: 'alpha'|'ore'|'power', base: number (starting value in BASE
  // units), unit: preferred starting unit, max: number (base units, enables the
  // MAX control), onChange(base, unit) }.
  //
  // Always reports BASE units — callers never see the picked unit unless they
  // want to echo it. The starting unit defaults to the one the current value
  // would print in, so the field opens showing a number a human can read.
  function amountField(label, opts) {
    opts = opts || {};
    var kind = opts.kind || 'alpha';
    var unit = opts.unit || stepFor(opts.base || opts.max || 0, SCALES[kind])[2];
    var div = unitDivisor(kind, unit);
    var shown = opts.base ? Number(opts.base) / div : '';

    var row = el('div', 'amount-field');
    var input = el('input', 'amount-input');
    input.type = 'text';
    input.inputMode = 'decimal';
    input.value = shown === '' ? '' : String(trim2(Number(shown)));
    input.placeholder = '0';

    function emit() {
      var n = Number(String(input.value).replace(/[, ]/g, ''));
      if (isNaN(n)) n = 0;
      if (opts.onChange) opts.onChange(Math.round(n * div), unit);
    }
    input.addEventListener('input', emit);

    var sel = selectBox(unit, unitOptions(kind), function (u) {
      // Keep the QUANTITY, restate it in the new unit — switching from g to mg
      // should show the same amount, not silently multiply it by a thousand.
      var n = Number(String(input.value).replace(/[, ]/g, ''));
      var baseNow = isNaN(n) ? 0 : n * div;
      unit = u;
      div = unitDivisor(kind, unit);
      input.value = baseNow ? String(trim2(baseNow / div)) : '';
      emit();
    });
    sel.className = 'amount-unit';

    row.appendChild(input);
    row.appendChild(sel);
    if (opts.max != null) {
      var max = el('a', 'amount-max', 'MAX');
      max.href = 'javascript:void(0)';
      max.title = 'Use the whole available balance';
      max.addEventListener('click', function () {
        // EXACTLY the ceiling, at full precision — not a rounded rendering of
        // it. `trim2` rounds half-up, so a 13.316001349 Kg ceiling displayed as
        // "13.32" emitted 13.32 Kg: ~4 g ABOVE the real balance, and the chain
        // rejects the whole message. Every use of MAX here is "all of it"
        // against a hard limit (liquid Alpha, allocatable headroom, removable
        // stake), so the exact figure is the only correct one.
        input.value = String(Number(opts.max) / div);
        emit();
      });
      row.appendChild(max);
    }
    var node = field(label, row, opts.hint);
    node.classList.add('cfg-field-amount');
    return node;
  }

  // ── Durations ────────────────────────────────────────────────────────────
  // One formatter, replacing `ago` / `fmtEta` / `fmtCadence`, which existed as
  // three because none of them took options. Seconds in; `opts.zero` is the
  // word for 0 ("now" for an ETA, nothing for a cadence).
  function duration(seconds, opts) {
    opts = opts || {};
    if (seconds == null || isNaN(seconds)) return opts.empty || '—';
    var s = Math.max(0, Number(seconds));
    if (s <= 0 && opts.zero) return opts.zero;
    if (s < 60) return Math.round(s) + 's';
    if (s < 3600) return Math.round(s / 60) + 'm';
    if (s < 86400) return (s / 3600).toFixed(1).replace(/\.0$/, '') + 'h';
    return Math.round(s / 86400) + 'd';
  }

  // ── One state block for loading / empty / error ──────────────────────────
  // Replaces four empty-state and seven error-state idioms with SUI's inline
  // alert. `kind` picks the severity colour and the default icon.
  var STATE_KINDS = {
    loading: { mod: 'sui-mod-secondary', icon: 'icon-in-progress' },
    empty: { mod: 'sui-mod-secondary', icon: 'icon-info' },
    info: { mod: 'sui-mod-primary', icon: 'icon-info' },
    warning: { mod: 'sui-mod-warning', icon: 'icon-alert' },
    error: { mod: 'sui-mod-destructive', icon: 'icon-alert' },
  };
  function stateBlock(kind, text, iconOverride) {
    var k = STATE_KINDS[kind] || STATE_KINDS.info;
    var a = el('div', 'sui-message-inline-alert ' + k.mod);
    a.appendChild(el('i', iconClass(iconOverride || k.icon, 'sui-icon-md')));
    var t = el('div', 'sui-message-inline-alert-text');
    t.textContent = text;
    a.appendChild(t);
    return a;
  }

  // Render into a container with one error path, replacing the five
  // byte-identical `innerHTML=''` + catch blocks across the pages.
  // `build(host)` gets a freshly emptied container; a throw anywhere in it
  // leaves the error block and nothing half-painted.
  function renderInto(id, build) {
    var host = document.getElementById(id);
    if (!host) return Promise.resolve();
    return Promise.resolve()
      .then(function () {
        host.innerHTML = '';
        return build(host);
      })
      .catch(function (e) {
        host.innerHTML = '';
        host.appendChild(stateBlock('error', String(e)));
      });
  }

  // One busy state. `.is-busy` and `sui-mod-disabled` were both in use on the
  // same buttons, so a control could be one and not the other.
  function busy(node, on) {
    if (!node) return;
    node.classList.toggle('sui-mod-disabled', !!on);
    node.classList.toggle('is-busy', !!on);
    if ('disabled' in node) node.disabled = !!on;
  }

  // ── Pagination ───────────────────────────────────────────────────────────
  // SUI's component, following the webapp's Pagination.js contract exactly:
  // at most five number slots, prev/next OMITTED (not disabled) at the ends,
  // and the ellipsis is a <div> so it isn't clickable.
  function pageSlots(current, total) {
    if (total <= 1) return [1];
    var slots = [1];
    if (total >= 2) slots.push(total <= 5 || current <= 3 ? 2 : '...');
    if (total >= 3) {
      if (total <= 5 || current <= 3) slots.push(3);
      else if (current > 3 && total - current > 2) slots.push(current);
      else slots.push('...');
    }
    if (total >= 4) slots.push(total <= 5 ? 4 : '...');
    if (total >= 5) {
      if (total - current <= 2) { slots[2] = total - 2; slots[3] = total - 1; }
      slots.push(total);
    }
    return slots;
  }

  function pagination(current, total, onPick) {
    var wrap = el('div', 'sui-pagination');
    function chevron(dir, icon) {
      var a = el('a'); a.href = 'javascript:void(0)';
      a.appendChild(el('i', 'sui-icon sui-icon-md ' + icon));
      a.addEventListener('click', function () { onPick(current + dir); });
      return a;
    }
    if (current > 1) wrap.appendChild(chevron(-1, 'icon-chevron-left'));
    var nums = el('div', 'sui-pagination-numbers');
    pageSlots(current, total).forEach(function (n) {
      if (n === '...') { nums.appendChild(el('div', 'sui-pagination-number', '...')); return; }
      var a = el('a', 'sui-pagination-number' + (n === current ? ' sui-mod-active' : ''), String(n));
      a.href = 'javascript:void(0)';
      a.addEventListener('click', function () { onPick(n); });
      nums.appendChild(a);
    });
    wrap.appendChild(nums);
    if (current < total) wrap.appendChild(chevron(1, 'icon-chevron-right'));
    return wrap;
  }

  // ── listView ─────────────────────────────────────────────────────────────
  // The component this console was missing: one filtered, sorted, paginated
  // list that updates INCREMENTALLY.
  //
  // Every page used to rebuild its whole list with `innerHTML = ''` on each
  // refresh tick — which at 459 roster rows meant ~22k DOM nodes thrown away
  // and rebuilt every time, and destroyed scroll position, focus and any
  // half-typed filter text on a 2.5-20s cadence. Here rows are cached by key
  // and only re-rendered when their data actually changes, so an untouched
  // row keeps its identity (and its focus) across refreshes.
  //
  // opts: {
  //   key(row)->string        stable identity, required
  //   render(row)->Node       build a row
  //   sig(row)->string        change detector (default JSON of the row)
  //   pageSize                default 60
  //   filters[]               {key, type:'text'|'select'|'toggle', label, options?, placeholder?}
  //   filterFn(row, values)   true to keep
  //   sortKeys[], sortAccessors{}, sort{key,dir}
  //   toolbarExtra            Node appended to the toolbar (page-specific actions)
  //   empty                   text shown when nothing matches
  //   onCounts(shown, total)  called after each render
  // }
  function listView(opts) {
    var pageSize = opts.pageSize || 60;
    var state = {
      rows: [], page: 1,
      values: {},
      sort: opts.sort || (opts.sortKeys && opts.sortKeys[0] ? { key: opts.sortKeys[0].key, dir: 1 } : null),
    };
    (opts.filters || []).forEach(function (f) { state.values[f.key] = f.type === 'toggle' ? false : ''; });

    var root = el('div', 'listview');
    var toolbar = el('div', 'listview-toolbar');
    var body = resultTable();
    body.classList.add('list-managed');
    var footer = el('div', 'listview-foot');
    var pager = el('div', 'listview-pager');
    root.appendChild(toolbar);
    root.appendChild(body);
    root.appendChild(footer);
    root.appendChild(pager);

    // Toolbar is built ONCE — rebuilding it is what used to eat keystrokes.
    (opts.filters || []).forEach(function (f) {
      var ctl;
      if (f.type === 'select') {
        ctl = selectBox('', f.options || [], function (v) { state.values[f.key] = v; state.page = 1; paint(); });
      } else if (f.type === 'toggle') {
        var wrapT = el('label', 'listview-toggle');
        var cb = checkbox(false, null, function (on) { state.values[f.key] = on; state.page = 1; paint(); });
        wrapT.appendChild(cb);
        wrapT.appendChild(el('span', null, f.label));
        ctl = wrapT;
      } else {
        ctl = el('input', 'listview-text');
        ctl.type = 'search';
        ctl.placeholder = f.placeholder || f.label || 'filter';
        // `input`, not `change`: filtering should feel live, and because the
        // toolbar is never rebuilt the field keeps focus while you type.
        ctl.addEventListener('input', function () {
          state.values[f.key] = ctl.value;
          state.page = 1;
          paint();
        });
      }
      toolbar.appendChild(ctl);
    });
    if (opts.sortKeys && state.sort) {
      toolbar.appendChild(sortControl(opts.sortKeys, state.sort, function () { paint(); }));
    }
    if (opts.toolbarExtra) toolbar.appendChild(opts.toolbarExtra);

    var cache = {};   // key -> { node, sig }

    function visible() {
      var out = state.rows;
      if (opts.filterFn) {
        out = out.filter(function (r) { return opts.filterFn(r, state.values); });
      }
      if (state.sort && opts.sortAccessors) out = sortBy(out, state.sort, opts.sortAccessors);
      return out;
    }

    function paint() {
      var shown = visible();
      var total = Math.max(1, Math.ceil(shown.length / pageSize));
      if (state.page > total) state.page = total;
      var start = (state.page - 1) * pageSize;
      var slice = shown.slice(start, start + pageSize);

      // Build/reuse nodes for this page.
      var wanted = slice.map(function (r) {
        var k = opts.key(r);
        var s = opts.sig ? opts.sig(r) : JSON.stringify(r);
        var hit = cache[k];
        if (!hit || hit.sig !== s) {
          hit = cache[k] = { node: opts.render(r), sig: s };
        }
        return hit.node;
      });

      // Reorder in place. Only touch the DOM where it actually differs, so a
      // focused control inside an unchanged row is never moved or replaced.
      var cur = body.firstChild;
      wanted.forEach(function (node) {
        if (cur === node) { cur = cur.nextSibling; return; }
        body.insertBefore(node, cur);
      });
      while (cur) { var next = cur.nextSibling; body.removeChild(cur); cur = next; }

      // Drop cached nodes for rows that no longer exist at all, so the cache
      // can't grow without bound as the roster churns.
      var live = {};
      shown.forEach(function (r) { live[opts.key(r)] = true; });
      Object.keys(cache).forEach(function (k) { if (!live[k]) delete cache[k]; });

      footer.innerHTML = '';
      if (!shown.length) {
        footer.appendChild(stateBlock('empty', opts.empty || 'nothing to show'));
      } else {
        // Say what is on screen versus what exists — the old lists silently
        // truncated at six different hard-coded caps.
        var from = start + 1, to = Math.min(start + pageSize, shown.length);
        var txt = shown.length > pageSize
          ? from + '–' + to + ' of ' + shown.length
          : shown.length + ' shown';
        if (shown.length !== state.rows.length) txt += ' (' + state.rows.length + ' total)';
        footer.appendChild(el('span', 'ops-muted', txt));
      }

      pager.innerHTML = '';
      if (total > 1) {
        pager.appendChild(pagination(state.page, total, function (p) {
          state.page = Math.min(Math.max(1, p), total);
          paint();
        }));
      }
      if (opts.onCounts) opts.onCounts(shown, state.rows);
    }

    return {
      node: root,
      body: body,
      toolbar: toolbar,
      state: state,
      setRows: function (rows) { state.rows = rows || []; paint(); },
      refresh: paint,
      // Force a row to rebuild (after an action mutates it locally).
      invalidate: function (k) { delete cache[k]; paint(); },
      visible: visible,
    };
  }

  // Row detail / editors, in the game's own offcanvas drawer (SUIOffcanvas —
  // a singleton panel appended to <body>, opened from the right). Its own
  // setContent() takes an HTML string; we append the node instead so live
  // controls keep their listeners. Returns a close() fn.
  //
  // Falls back to a plain centred overlay if the SUI module didn't load, so a
  // module failure degrades to a working dialog rather than a dead button.
  function drawer(title, contentNode) {
    var oc = window.SUIRuntime && window.SUIRuntime.offcanvas;
    if (!oc || !oc.offcanvasElm) return fallbackModal(title, contentNode);
    oc.setHeader(esc(title));
    var body = oc.offcanvasElm.querySelector('.sui-offcanvas-body');
    body.innerHTML = '';
    if (contentNode) body.appendChild(contentNode);
    // SUIOffcanvas.setPlacement assigns this.placement BEFORE removing the old
    // class, so it removes and re-adds the same (new) class and the previous
    // one is never dropped — leaving sui-mod-left AND sui-mod-right on the
    // element. Clear both ourselves rather than patching the submodule.
    oc.offcanvasElm.classList.remove('sui-mod-left', 'sui-mod-right');
    oc.setPlacement('right');
    oc.open();
    return function close() { oc.close(); };
  }

  function fallbackModal(title, contentNode) {
    var existing = document.getElementById('detail-overlay');
    if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
    var ov = el('div', null); ov.id = 'detail-overlay';
    var panel = el('div', 'detail-panel');
    var head = el('div', 'detail-head');
    head.appendChild(el('div', 'sui-text-header', title));
    var x = el('a', 'detail-x'); x.href = 'javascript:void(0)';
    x.appendChild(el('i', 'icon-close'));
    function close() { if (ov.parentNode) ov.parentNode.removeChild(ov); }
    x.addEventListener('click', close);
    head.appendChild(x);
    panel.appendChild(head);
    if (contentNode) panel.appendChild(contentNode);
    ov.appendChild(panel);
    ov.addEventListener('click', function (e) { if (e.target === ov) close(); });
    document.body.appendChild(ov);
    return close;
  }
  Board.helpers = {
    esc: esc, el: el, row: row, card: card, badge: badge, battery: battery,
    progressBar: progressBar, fmtNum: fmtNum, ago: ago, alertLine: alertLine,
    iconClass: iconClass, resultTable: resultTable, resource: resource, resultRow: resultRow,
    statTile: statTile,
    // `detailModal` is the historical name every page already calls; it now
    // opens the native drawer. Kept as an alias rather than renamed across
    // every call site in one go.
    sortControl: sortControl, sortBy: sortBy, drawer: drawer, detailModal: drawer,
    pfpPortrait: pfpPortrait,
    checkbox: checkbox, stepper: stepper, selectBox: selectBox, textBox: textBox,
    navStrip: navStrip, field: field, amountField: amountField,
    scaleSet: scaleSet, unitOptions: unitOptions, unitDivisor: unitDivisor,
    duration: duration, stateBlock: stateBlock, renderInto: renderInto, busy: busy,
    listView: listView, pagination: pagination, pageSlots: pageSlots,
    fmtInt: fmtInt, fmtWatts: fmtWatts, fmtAlpha: fmtAlpha, fmtOre: fmtOre,
    denomName: denomName, denomAmount: denomAmount, denomQty: denomQty,
    confirmModal: confirmModal,
  };

  // ── Denom naming ────────────────────────────────────────────────────────
  // Every guild mints `uguild.<id>` and publishes cosmetic names for it, so
  // `uguild.0-5` is displayed as *snack*. Two guilds can independently pick
  // the same word, which is why anything that can show more than one guild's
  // token (the ledger does exactly that) disambiguates with the guild tag.
  //
  // `style`:
  //   'cosmetic' (default) — "snack"           readable, the common case
  //   'both'               — "snack · uguild.0-5"
  //                          REQUIRED anywhere getting it wrong costs money:
  //                          transfer forms, the confirm dialog, row detail.
  //   'chain'              — "uguild.0-5"
  // Decided once here rather than at every call site.
  function denomName(chainDenom, registry, opts) {
    opts = opts || {};
    var info = (registry || {})[chainDenom];
    if (chainDenom === 'ore') return opts.style === 'chain' ? 'ore' : 'Ore';
    if (!info) return chainDenom;                       // unknown: never invent
    var cosmetic = info.display_name || chainDenom;
    if (opts.tag !== false && info.guild_tag) cosmetic += ' [' + info.guild_tag + ']';
    if (opts.style === 'chain') return chainDenom;
    if (opts.style === 'both') return cosmetic + ' · ' + chainDenom;
    return cosmetic;
  }
  // Raw base units → display units, using the denom's own exponent
  // (ualpha 10^6 → Alpha, uguild.0-5 10^6 → snack). Ore is already whole grams.
  // Returns a bare number string; see denomQty for the number WITH its unit.
  function denomAmount(amount, chainDenom, registry) {
    var info = (registry || {})[chainDenom];
    var exp = info ? (info.exponent || 0) : 0;
    return fmtNum(Number(amount || 0) / Math.pow(10, exp));
  }
  // A quantity with the right unit attached, dropping to the BASE unit when
  // the display unit would round the value away.
  //
  // `amount` MUST be base units — `amount_p` from a GRASS event, `amount_base`
  // from the normalised ledger, or a raw bank balance. Never a bare `amount`
  // off an inventory event: that one is already floored to display units, and
  // dividing it again is how a 2-Alpha credit rendered as "0".
  //
  // The base-unit fallback matters because a genuinely tiny balance (2 ualpha)
  // has no honest display form — that is what the guild-published `base_name`
  // (ualpha → "μg Alpha", uguild.0-5 → "ack") exists for.
  function denomQty(amount, chainDenom, registry) {
    // The two denoms the GAME itself has a display ladder for are shown the
    // game's way — "7.57Kg", the same string the HUD prints. Only guild-minted
    // tokens, which the game has no ladder for, fall back to the cosmetic
    // name + exponent published in guild.json.
    if (chainDenom === 'ualpha') return fmtAlpha(Number(amount || 0));
    if (chainDenom === 'ore') return fmtOre(Number(amount || 0));
    var info = (registry || {})[chainDenom];
    var exp = info ? (info.exponent || 0) : 0;
    var raw = Number(amount || 0);
    var disp = raw / Math.pow(10, exp);
    if (exp > 0 && raw !== 0 && Math.abs(disp) < 0.01) {
      return fmtInt(raw) + ' ' + ((info && info.base_name) || chainDenom);
    }
    return fmtNum(disp) + ' ' + denomName(chainDenom, registry);
  }

  // ── Confirm dialog ──────────────────────────────────────────────────────
  // SUI's system modal. Used for anything irreversible; `bodyNode` should
  // spell out exactly what is about to happen, not just ask "are you sure".
  function confirmModal(title, bodyNode, ctaLabel, onConfirm) {
    var ov = el('div', 'modal-overlay');
    var modal = el('div', 'sui-message-system-modal');
    var frame = el('div', 'sui-message-system-modal-frame');
    var left = el('div', 'sui-message-system-modal-frame-left');
    left.appendChild(el('div', 'sui-message-system-modal-frame-left-top'));
    var mid = el('div', 'sui-message-system-modal-frame-left-middle');
    mid.appendChild(el('i', iconClass('icon-attention', 'sui-icon-md')));
    left.appendChild(mid);
    left.appendChild(el('div', 'sui-message-system-modal-frame-left-bottom'));
    frame.appendChild(left);

    var center = el('div', 'sui-message-system-model-frame-center');
    var stack = el('div');
    stack.appendChild(el('div', 'sui-text-header', title));
    if (bodyNode) stack.appendChild(bodyNode);
    center.appendChild(stack);
    frame.appendChild(center);
    modal.appendChild(frame);

    var cta = el('div', 'sui-message-system-modal-cta');
    function close() { if (ov.parentNode) ov.parentNode.removeChild(ov); }
    var cancelW = el('div', 'sui-message-system-modal-cta-btn-wrapper');
    var cancel = el('a', 'sui-screen-btn sui-mod-secondary');
    cancel.href = 'javascript:void(0)';
    cancel.appendChild(el('span', null, 'Cancel'));
    cancel.addEventListener('click', close);
    cancelW.appendChild(cancel);
    var goW = el('div', 'sui-message-system-modal-cta-btn-wrapper');
    var go = el('a', 'sui-screen-btn sui-mod-destructive');
    go.href = 'javascript:void(0)';
    go.appendChild(el('span', null, ctaLabel || 'Confirm'));
    go.addEventListener('click', function () { close(); onConfirm(); });
    goW.appendChild(go);
    cta.appendChild(cancelW); cta.appendChild(goW);
    modal.appendChild(cta);

    ov.appendChild(modal);
    ov.addEventListener('click', function (e) { if (e.target === ov) close(); });
    document.body.appendChild(ov);
    return close;
  }

  // ── Router ────────────────────────────────────────────────────────────────
  // #/fleet, #/map?p=2-459 … Persistent [hidden]-toggled page divs.
  Board.pageParams = {};
  function route() {
    var h = location.hash.replace(/^#\/?/, '');
    var qi = h.indexOf('?');
    var params = {};
    if (qi >= 0) {
      h.slice(qi + 1).split('&').forEach(function (kv) {
        var p = kv.split('=');
        if (p[0]) params[decodeURIComponent(p[0])] = decodeURIComponent(p[1] || '');
      });
      h = h.slice(0, qi);
    }
    // `#/fleet` and friends resolve to their new home rather than dead-ending.
    var parts = h.split('/').filter(Boolean);
    if (parts.length === 1 && LEGACY_ROUTES[parts[0]]) parts = LEGACY_ROUTES[parts[0]].split('/');
    var moved = LEGACY_SECTIONS[parts.join('/')];
    if (moved) parts = moved.split('/');
    // A pop-out window shows its one section regardless of the hash.
    if (Board.solo) parts = SOLO_VIEWS[Board.solo].split('/');

    var area = findArea(parts[0]) || AREAS[0];
    var section = findSection(area, parts[1]);

    Board.area = area.key;
    Board.section = section.key;
    Board.current = section.page;
    Board.pageParams = params;

    PAGE_NAMES.forEach(function (p) {
      var div = document.getElementById('page-' + p);
      if (div) div.hidden = (p !== section.page);
    });
    var tabs = document.querySelectorAll('#board-tabs .sui-screen-nav-item');
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].classList.toggle('sui-mod-active', tabs[i].getAttribute('data-area') === area.key);
    }
    renderSubnav(area, section);

    var def = Board.pages[section.page];
    // Claim the cadence slot NOW. onEnter already fetches; without this the
    // 1s scheduler saw lastRun === 0 and fired a second identical fetch the
    // moment the page opened.
    if (def) def.lastRun = Date.now();
    if (def && def.onEnter) def.onEnter(params, section.view);
  }

  // The sub-nav is a real link strip: sections are in the hash, so they are
  // bookmarkable, survive a reload, and Back steps between them.
  function renderSubnav(area, section) {
    var host = document.getElementById('board-subnav');
    if (!host) return;
    host.innerHTML = '';
    // Hidden sections (pop-out-only pages) never render a nav entry.
    var visible = area.sections.filter(function (s) { return !s.hidden; });
    if (Board.solo || visible.length < 2) return;
    host.appendChild(navStrip(visible, section.key, null, function (k) {
      return '#/' + area.key + '/' + k;
    }));
  }

  // ── Scheduler: one 1s tick dispatching per-page cadence ─────────────────
  setInterval(function () {
    if (document.visibilityState === 'hidden') return;
    var def = Board.pages[Board.current];
    if (!def || !def.refresh || !def.cadenceMs) return;
    var now = Date.now();
    if (now - def.lastRun >= def.cadenceMs) {
      def.lastRun = now;
      runRefresh(def);
    }
  }, 1000);

  // One place that runs a page refresh, so the "updated" stamp is truthful on
  // every page instead of only the ones that remember to call Board.stamp.
  function runRefresh(def) {
    var btn = document.getElementById('board-refresh');
    if (btn) btn.classList.add('is-busy');
    var done = function () {
      if (btn) btn.classList.remove('is-busy');
      Board.stamp('updated ' + new Date().toLocaleTimeString());
    };
    var r;
    try { r = def.refresh(); } catch (e) { done(); throw e; }
    if (r && r.then) return r.then(done, done);
    done();
    return r;
  }

  // Manual Refresh button = refresh the CURRENT page.
  /* Is the guild talking?
   *
   * Team Ops is where a player spends the most time, and it had no way to say
   * that they had been named in a room — the two halves of the app ran side by
   * side without either knowing the other was busy.
   *
   * Polled rather than pushed. `matrix_unread` is a synchronous read of state
   * the sync loop already maintains, and that loop runs app-wide from boot for
   * any guild with a stored session — it does NOT depend on the Comms window
   * being open, which is the whole reason this indicator can mean anything.
   *
   * Silent when there is nothing: the control hides itself at zero rather than
   * sitting there showing a zero, because a console full of zeroes is a console
   * people stop reading.
   */
  var COMMS_POLL_MS = 15000;

  function paintComms(d) {
    var btn = document.getElementById('board-comms');
    if (!btn) return;
    var count = (d && Number(d.count)) || 0;
    var mention = !!(d && d.mention);
    btn.classList.toggle('hidden', count === 0 && !mention);
    btn.classList.toggle('board-mod-mention', mention);
    var label = document.getElementById('board-comms-count');
    if (label) label.textContent = count > 99 ? '99+' : (count ? String(count) : '');
    btn.title = mention
      ? 'You were mentioned in Comms'
      : (count === 1 ? '1 unread message in Comms'
                     : count + ' unread messages in Comms');
  }
  Board.paintComms = paintComms;

  function wireComms() {
    var btn = document.getElementById('board-comms');
    if (!btn) return;
    btn.addEventListener('click', function () {
      Board.T.core.invoke('open_chat_window').catch(function () {});
    });
    var tick = function () {
      Board.T.core.invoke('matrix_unread')
        // Comms not signed in is the ordinary case, not an error: the whole
        // feature stays hidden for a player who has never opened it.
        .then(paintComms)
        .catch(function () { paintComms(null); });
    };
    tick();
    setInterval(tick, COMMS_POLL_MS);
  }

  function wireRefreshButton() {
    var btn = document.getElementById('board-refresh');
    if (!btn) return;
    btn.addEventListener('click', function () {
      var def = Board.pages[Board.current];
      if (def && def.refresh) {
        def.lastRun = Date.now();
        runRefresh(def);
      }
    });
  }
  Board.stamp = function (text) {
    var s = document.getElementById('board-updated');
    if (s) s.textContent = text;
  };

  // ── HEALTH STRIP ────────────────────────────────────────────────────────
  // The watchdog has always known whether sync is alive, which loops are
  // overdue or wedged, how far the AIMD fan-out has backed off, and whether
  // telemetry is dropping — none of it had a surface, so a stalled machine
  // looked exactly like a quiet one. This strip sits above the game snapshot
  // for that reason: a stale snapshot is only readable once you know sync
  // stopped producing it.
  function healthTiles(h) {
    var strip = el('div', 'hstrip');
    var status = String(h.status || 'unknown');
    var mod = status === 'ok' ? 'ok' : (status === 'warn' ? 'live' : 'bad');
    var icon = status === 'ok' ? 'icon-success' : (status === 'warn' ? 'icon-attention' : 'icon-alert');
    strip.appendChild(statTile('status', status.toUpperCase(), icon, mod));

    var age = (h.sync_age_ms || 0) / 1000;
    var interval = (h.sync_interval_ms || 0) / 1000;
    // Late is relative to the loop's own cadence, not a fixed number.
    var syncBad = interval > 0 && age > interval * 3;
    strip.appendChild(statTile('sync age', duration(age), null,
      syncBad ? 'bad' : 'ok'));

    var overdue = h.loops_overdue || [];
    var wedged = h.loops_wedged || [];
    strip.appendChild(statTile('loops overdue', overdue.length || '0', null,
      overdue.length ? 'live' : 'muted'));
    strip.appendChild(statTile('loops wedged', wedged.length || '0', null,
      wedged.length ? 'bad' : 'muted'));

    var c = h.concurrency || {};
    var eff = c.effective, max = c.max;
    strip.appendChild(statTile('fan-out', (eff == null ? '?' : eff) + ' / ' + (max == null ? '?' : max),
      null, (eff != null && max != null && eff < max) ? 'live' : 'muted'));

    strip.appendChild(statTile('uptime', duration(h.uptime_s || 0), null, 'muted'));
    var drops = h.telemetry_dropped || 0;
    strip.appendChild(statTile('telemetry drops', drops, null, drops ? 'live' : 'muted'));
    return strip;
  }

  // Shared with the System/Diagnostics page, which shows the same tiles above
  // the loop and transaction detail rather than a second, drifting summary.
  Board.healthTiles = healthTiles;

  function renderHealth() {
    return Board.T.core.invoke('mcp_health').then(function (h) {
      renderInto('ops-health', function (body) {
        body.appendChild(healthTiles(h));

        // Name the loops, don't just count them — "2 overdue" is not
        // actionable, "auto_raid overdue" is. (The snapshot reports names.)
        var notes = el('div', 'hblocked');
        (h.loops_wedged || []).forEach(function (w) {
          notes.appendChild(stateBlock('error', w + ' wedged — its scan has been running long enough ' +
            'that the single-flight guard never cleared'));
        });
        (h.loops_overdue || []).forEach(function (o) {
          notes.appendChild(stateBlock('warning', o + ' overdue — enabled, but has not completed a ' +
            'scan within its own interval'));
        });
        // Enabled, running on time, and still unable to act (telemetry::blocked).
        (h.loops_blocked || []).forEach(function (b) {
          notes.appendChild(stateBlock('warning', (b.loop || 'loop') + ' blocked — ' + (b.reason || '?')));
        });
        if (notes.childNodes.length) body.appendChild(card('SYSTEM', notes));
      });
    }).catch(function (e) {
      renderInto('ops-health', function (body) {
        body.appendChild(stateBlock('error', 'health unavailable: ' + e));
      });
    });
  }

  // ── OPS page (existing Rust-rendered HTML path, unchanged) ──────────────
  function setupOps() {
    var T = Board.T;
    var root = document.getElementById('root');
    function render(html) { if (typeof html === 'string') root.innerHTML = html; }

    // First paint from the cached snapshot so the window is never blank while
    // the first live recompute is in flight.
    T.core.invoke('mcp_board_html').then(render).catch(function () {});
    // A structs_board tool call still pushes updates; keep listening for them.
    T.event.listen('board-update', function (e) {
      render(e && e.payload && e.payload.html);
    });

    var refreshing = false;
    function refreshBoard() {
      if (refreshing) return Promise.resolve();
      refreshing = true;
      var btn = document.getElementById('board-refresh');
      if (btn) btn.classList.add('is-busy');
      return T.core.invoke('mcp_board_refresh').then(function (html) {
        render(html);
        Board.stamp('updated ' + new Date().toLocaleTimeString());
      }).catch(function () {}).then(function () {
        refreshing = false;
        if (btn) btn.classList.remove('is-busy');
      });
    }
    Board.registerPage('ops', {
      refresh: function () { return Promise.all([refreshBoard(), renderHealth()]); },
      cadenceMs: 10000,
    });
    // A pop-out shows one section; don't pay for the Ops snapshot or the
    // health read in a window that will never display them.
    if (!Board.solo) {
      refreshBoard(); // immediate live paint on open
      renderHealth();
    }
  }

  // ── EVENT FEED (global infra; lives on the Ops page) ────────────────────
  // ── EVENT FEED ───────────────────────────────────────────────────────────
  // Two problems this solves. First, the stream is overwhelmingly one loop
  // repeating itself — a live sample was 85 of 104 entries from just three
  // message templates (54 of them the same auto_harvest line), which buried
  // the raid alarm and the lost Command Ship. Consecutive entries from the
  // same source with the same shape now collapse into one row with a count.
  //
  // Second, severity had no effect on placement, so "something needs you" sat
  // wherever it happened to land in time order. Important entries are now
  // ALSO pinned into a NEEDS YOU card above the stream. They stay in the
  // stream too — the stream is the record, the card is the summons.
  var FEED_MAX_ROWS = 150;
  var FEED_MAX_ALERTS = 8;

  // Collapse a message to its shape: digits (counts, ids, durations) are what
  // vary between otherwise identical lines.
  function feedTemplate(e) {
    return (e.source || '') + '|' + String(e.message).replace(/\d+/g, 'N');
  }

  function feedRow(e, opts) {
    var li = document.createElement('li');
    if (e.severity === 'important') li.className = 'feed-important';
    else if (e.severity === 'notice') li.className = 'feed-notice';
    li.dataset.tkey = feedTemplate(e);
    li.dataset.count = '1';
    li.appendChild(el('span', 'feed-ts', new Date(e.ts_ms).toLocaleTimeString()));
    li.appendChild(el('span', 'feed-src', '[' + e.source + ']'));
    var count = el('span', 'feed-count');
    count.hidden = true;
    li.appendChild(count);
    li.appendChild(el('span', 'feed-msg', e.message));
    if (opts && opts.noCollapse) li.dataset.tkey = '';
    return li;
  }

  // Fold `e` into `li` if it is another instance of the same line: bump the
  // count, and show the NEWEST text and time (the latest numbers are the ones
  // worth reading).
  function feedFold(li, e) {
    var n = (parseInt(li.dataset.count, 10) || 1) + 1;
    li.dataset.count = String(n);
    li.querySelector('.feed-ts').textContent = new Date(e.ts_ms).toLocaleTimeString();
    li.querySelector('.feed-msg').textContent = e.message;
    var c = li.querySelector('.feed-count');
    c.textContent = '×' + n;
    c.hidden = false;
  }

  function setupFeed() {
    var T = Board.T;
    var feed = document.getElementById('feed-list');
    var alerts = document.getElementById('feed-alerts');
    var alertCard = document.getElementById('feed-alerts-card');

    function feedAdd(e) {
      if (!e || !e.message) return;
      if (feed.firstChild && feed.firstChild.className === 'ops-muted') feed.innerHTML = '';

      var top = feed.firstChild;
      if (top && top.dataset && top.dataset.tkey && top.dataset.tkey === feedTemplate(e)) {
        feedFold(top, e);
      } else {
        feed.insertBefore(feedRow(e), feed.firstChild); // newest first
        while (feed.children.length > FEED_MAX_ROWS) feed.removeChild(feed.lastChild);
      }

      if (e.severity === 'important' && alerts) {
        // Never collapse an alert: two raids on two planets are two events.
        alerts.insertBefore(feedRow(e, { noCollapse: true }), alerts.firstChild);
        while (alerts.children.length > FEED_MAX_ALERTS) alerts.removeChild(alerts.lastChild);
        if (alertCard) alertCard.hidden = false;
      }
    }

    T.core.invoke('mcp_board_feed').then(function (entries) {
      (entries || []).forEach(feedAdd); // oldest→newest, so newest ends on top
    }).catch(function () {});
    T.event.listen('board-feed', function (e) { feedAdd(e && e.payload); });
  }

  // ── AGENT UI directives (global; visible on every tab) ──────────────────
  // Toasts + prompts from the policy engine / board component directives
  // render here (never over the main game view). Prompts answer back via the
  // mcp_ui_response command. Rust retries emits while a freshly-opened window
  // loads, so dedupe by directive_id.
  function setupAgentUi() {
    var T = Board.T;
    var agentBox = document.getElementById('agent-ui');
    var agentSeen = {};
    function agentRespond(id, value, cancelled) {
      T.core.invoke('mcp_ui_response', {
        response: { directive_id: id, value: value == null ? null : value, cancelled: !!cancelled }
      }).catch(function () {});
    }
    function agentRemove(id) {
      var n = document.getElementById('agent-d-' + id);
      if (n && n.parentNode) n.parentNode.removeChild(n);
    }
    function agentCard(d) {
      var c = d.component || {};
      var isPrompt = d.mode === 'prompt';
      var cardEl = el('div', 'agent-card' + (c.kind === 'toast' || c.kind === 'hud_badge' ? ' agent-toast' : ''));
      cardEl.id = 'agent-d-' + d.directive_id;
      var head = el('div', 'agent-card-head');
      var mark = el('span', 'agent-mark', '⚡ AGENT');
      var title = el('span', 'agent-title', c.title || c.headline || c.kind || 'agent');
      var x = el('span', 'agent-x', '✕');
      x.addEventListener('click', function () {
        if (isPrompt) agentRespond(d.directive_id, null, true);
        agentRemove(d.directive_id);
      });
      head.appendChild(mark); head.appendChild(title); head.appendChild(x);
      cardEl.appendChild(head);
      var bodyText = c.body || c.message || '';
      if (bodyText) {
        var body = el('div', 'agent-body', bodyText);
        cardEl.appendChild(body);
      }
      var buttons = c.buttons || c.options || [];
      if (isPrompt) {
        if (!buttons.length) buttons = [{ label: 'OK', value: 'ok' }];
        var brow = el('div', 'agent-buttons');
        buttons.forEach(function (b) {
          var btn = el('button', 'agent-btn', (b && b.label) || String(b));
          btn.addEventListener('click', function () {
            agentRespond(d.directive_id, (b && b.value !== undefined) ? b.value : b, false);
            agentRemove(d.directive_id);
          });
          brow.appendChild(btn);
        });
        cardEl.appendChild(brow);
      }
      return cardEl;
    }
    T.event.listen('mcp_ui_directive', function (e) {
      var d = e && e.payload;
      if (!d || !d.directive_id || agentSeen[d.directive_id]) return;
      var c = d.component || {};
      if (c.kind === 'dismiss') { if (c.target_id) agentRemove(c.target_id); return; }
      agentSeen[d.directive_id] = true;
      agentBox.insertBefore(agentCard(d), agentBox.firstChild);
      if (d.mode !== 'prompt') {
        setTimeout(function () { agentRemove(d.directive_id); }, 12000);
      }
    });
  }

  // ── Boot ─────────────────────────────────────────────────────────────────
  function boot() {
    var T = window.__TAURI__;
    if (!T || !T.event || !T.core) { setTimeout(boot, 150); return; }
    // Wait for the rest of the document's scripts. The page modules register
    // themselves from their own <script> tags further down the body, and a 0ms
    // timeout is NOT enough to guarantee they have run: while board-pages.js is
    // still being FETCHED the parser is blocked but the event loop is not, so
    // the timer fires in that gap. route() then finds `Board.pages` empty,
    // unhides the right page div and calls no onEnter at all — a board that
    // sits on "…loading" forever with no error anywhere. Reproduced over HTTP
    // in the harness, roughly one load in three.
    //
    // DOMContentLoaded is the event that actually means "every classic script
    // in this document has executed".
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () { init(T); }, { once: true });
      return;
    }
    setTimeout(function () { init(T); }, 0);
  }
  function init(T) {
    Board.T = T;
    if (Board.solo) document.documentElement.setAttribute('data-solo', Board.solo);
    setupOps();
    setupFeed();
    // Agent directives belong in the full console — a pop-out log is not the
    // place for a prompt the operator might never see.
    if (!Board.solo) setupAgentUi();
    wireRefreshButton();
    wireComms();
    // Page modules (board-pages.js) have registered by now — script order +
    // the async boot poll guarantee it. Let them do Tauri-dependent setup.
    Object.keys(Board.pages).forEach(function (name) {
      var def = Board.pages[name];
      if (def.onBoot) def.onBoot();
    });
    window.addEventListener('hashchange', route);
    route();
  }
  boot();
})();
