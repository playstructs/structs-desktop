// SUI parts — one builder per part of the game's design system, shared by
// every window that draws SUI by hand (Team Ops, the Battle Simulator).
//
// Each builder returns a DOM node in SUI's own documented markup and holds no
// state of its own: a change is reported through the callback it was given.
// Team Ops' Board.helpers.checkbox/stepper/selectBox/textBox/field/confirmModal
// are aliases of these, so there is one copy of each, not one per window.
//
// This file MUST stay at the frontend ROOT: scripts/sync.sh deletes and
// rebuilds frontend/js/ from the webapp submodule.
(function () {
  'use strict';

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function icon(name, size) {
    return el('i', 'sui-icon ' + (size || 'sui-icon-md') + ' ' + name);
  }
  // 'primary' and 'sui-mod-primary' both name the same modifier.
  function mod(m) {
    if (!m) return '';
    return m.indexOf('sui-mod-') === 0 ? m : 'sui-mod-' + m;
  }

  // ── Checkbox ────────────────────────────────────────────────────────────
  // A DIV, matching SUI's documented markup. It must not be a <span>:
  // `label.sui-input-text span` (sui.css) styles *any* span inside the field
  // wrapper as the field's label — a span container inherited display:flex and
  // a 32px min-height and blew the control out to ~106px.
  function checkbox(checked, labelText, onChange) {
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

  // ── Stepper ─────────────────────────────────────────────────────────────
  // `opts`: {min,max,step,width}.
  //
  // Markup follows SUI's contract exactly — `sui-screen-btn sui-mod-secondary`
  // buttons carrying icon-subtract / icon-add, and the buttons as the input's
  // literal previous/next siblings, because that is how SUIInputStepper finds
  // them. The behaviour is wired here rather than by that module: it binds
  // each input once during autoInitAll, and these steppers are created long
  // after page load. Disabling the buttons at min/max is the one thing it does
  // that would otherwise be lost, so it is reproduced.
  //
  // The wrapper is a DIV for the checkbox's reason: inside field()'s label a
  // span wrapper was restyled by `label.sui-input-text span` into an 8px flex
  // caption.
  function stepper(value, opts, onChange) {
    opts = opts || {};
    var w = el('div', 'sui-input-stepper');
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
      b.appendChild(icon(iconName, 'sui-icon-md'));
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

  // ── Select ──────────────────────────────────────────────────────────────
  // SUI styles the BARE `select` element — no class. A `.sui-input-text` class
  // here would style nothing; the label wrapper from field() carries that.
  //
  // An entry may be a GROUP — `{ group: 'War', options: [...] }` — which
  // becomes an <optgroup>: a list long enough to need one is unreadable as a
  // flat scroll.
  function selectBox(value, options, onChange) {
    var s = el('select');
    function put(into, list) {
      (list || []).forEach(function (o) {
        if (o && o.group) {
          var g = el('optgroup');
          g.label = String(o.group);
          put(g, o.options);
          if (g.childNodes.length) into.appendChild(g);
          return;
        }
        var val = (o && o.value != null) ? o.value : o;
        var lbl = (o && o.label != null) ? o.label : o;
        var op = el('option', null, String(lbl));
        op.value = val;
        if (val === value) op.selected = true;
        if (o && o.disabled) op.disabled = true;
        into.appendChild(op);
      });
    }
    put(s, options);
    s.addEventListener('change', function () { onChange(s.value); });
    return s;
  }

  // ── Text box ────────────────────────────────────────────────────────────
  // SUI styles `label.sui-input-text input[type=text]`, a DESCENDANT selector,
  // so the input must sit inside field()'s label wrapper and carries no class
  // of its own.
  function textBox(value, placeholder, onChange) {
    var i = el('input');
    i.type = 'text';
    i.value = value == null ? '' : value;
    if (placeholder) i.placeholder = placeholder;
    i.addEventListener('change', function () { onChange(i.value); });
    return i;
  }

  // ── Field ───────────────────────────────────────────────────────────────
  // One labelled control, built the way the game builds them:
  // `label.sui-input-text` is SUI's universal field wrapper — its <span> labels
  // a stepper, a select or a nested checkbox, not just a text input (the
  // webapp's ScanViewModel). The control goes in as given: every control
  // builder above returns a DIV or a bare input/select, never a span.
  //
  // `hint` becomes a press-and-hold tooltip on a small secondary tip icon
  // rather than a permanent grey line under the label — SUITooltip delegates
  // from document.body, so this works on content rendered at any time. Each
  // trigger needs its own id and a positioned parent, which the <span> provides.
  //
  // An empty `label` draws NO caption: a control whose own choices name it does
  // not need a word above it saying so. The caller gives the control an
  // `aria-label` instead.
  //
  // `opts`: { className } — extra classes on the wrapper (Team Ops' cfg-field).
  var fieldSeq = 0;
  function field(label, controlNode, hint, opts) {
    opts = opts || {};
    var wrap = el('label', 'sui-input-text' + (opts.className ? ' ' + opts.className : ''));
    if (!label && !hint) { wrap.appendChild(controlNode); return wrap; }
    var cap = el('span');
    cap.appendChild(document.createTextNode(label || ''));
    if (hint) {
      // A NO-BREAK space: the caption span is a flex container, where an
      // ordinary trailing space collapses and the icon touches the word.
      cap.appendChild(document.createTextNode(' '));
      var tip = el('a', 'sui-text-secondary');
      tip.id = 'sp-tip-' + (++fieldSeq);
      tip.href = 'javascript:void(0)';
      tip.setAttribute('data-sui-tooltip', hint);
      tip.appendChild(el('i', 'sui-icon icon-tip'));
      cap.appendChild(tip);
    }
    wrap.appendChild(cap);
    wrap.appendChild(controlNode);
    return wrap;
  }

  // ── Radio rows ──────────────────────────────────────────────────────────
  // A pick-one list as SUI result rows, each led by the game's radio sprite:
  // the sprite carries the selected state, so no row gets an invented fill.
  //
  // `options`: [{ value, label, trail?(node), checked?, disabled? }].
  // `onPick(value, option)` fires on every CLICK of an enabled row — including
  // one that is already checked, which a `change` listener would swallow.
  // A pick that means "roll again" (the simulator's Random encounter) depends
  // on that.
  var radioSeq = 0;
  function radioRows(name, options, onPick) {
    var group = name || ('sp-radio-' + (++radioSeq));
    var list = el('div', 'sui-result-table sui-result-rows');
    list.setAttribute('role', 'radiogroup');
    (options || []).forEach(function (o) {
      var row = el('label', 'sui-result-row sp-choice');
      var box = el('div', 'sui-radio-container');
      var input = el('input', 'sui-radio');
      input.type = 'radio';
      input.name = group;
      input.value = o.value == null ? '' : String(o.value);
      input.checked = !!o.checked;
      input.disabled = !!o.disabled;
      box.appendChild(input);
      box.appendChild(el('span', 'sui-radio-display'));
      row.appendChild(box);
      row.appendChild(el('span', 'sui-text-label', o.label == null ? String(o.value) : String(o.label)));
      if (o.trail) row.appendChild(o.trail);
      if (o.disabled) row.setAttribute('aria-disabled', 'true');
      // A click on the <label> also dispatches a synthetic click on its input;
      // only the one that reaches the INPUT is counted, so a pick fires once
      // whether the row, the caption or the sprite was clicked. Keyboard
      // selection (arrow keys) changes the radio without a click, so `change`
      // covers that path; the click path marks itself to avoid a double fire.
      var clicked = false;
      input.addEventListener('click', function () {
        if (input.disabled) return;
        clicked = true;
        setTimeout(function () { clicked = false; }, 0);
        if (onPick) onPick(o.value, o);
      });
      input.addEventListener('change', function () {
        if (clicked || !input.checked) return;
        if (onPick) onPick(o.value, o);
      });
      list.appendChild(row);
    });
    return list;
  }

  // ── Badge ───────────────────────────────────────────────────────────────
  // A STATE: `mod` is default | warning | destructive | solid.
  function badge(text, m) {
    return el('span', 'sui-badge ' + mod(m || 'default'), text == null ? '' : String(text));
  }

  // ── Inline alert ────────────────────────────────────────────────────────
  // `level`: 'warning' (icon-attention) | 'destructive' (icon-alert). The text
  // colour follows the level through sui-parts.css — SUI's own alert text
  // hard-sets the body colour.
  function inlineAlert(level, text) {
    var destructive = level === 'destructive' || level === 'sui-mod-destructive';
    var a = el('div', 'sui-message-inline-alert ' + (destructive ? 'sui-mod-destructive' : 'sui-mod-warning'));
    a.appendChild(icon(destructive ? 'icon-alert' : 'icon-attention', 'sui-icon-md'));
    var t = el('div', 'sui-message-inline-alert-text');
    if (text != null && typeof text === 'object') t.appendChild(text);
    else t.textContent = text == null ? '' : String(text);
    a.appendChild(t);
    return a;
  }

  // ── System alert ────────────────────────────────────────────────────────
  // `mod`: primary | secondary | destructive | warning — the colour of the
  // left bar. `glyph`: an icon-* name. `buttons`: nodes for the close slot
  // (a frameless close link, a screen button). Returns the alert node.
  var TITLE_TONE = { 'sui-mod-primary': 'sui-text-primary', 'sui-mod-destructive': 'sui-text-destructive' };
  function systemAlert(m, glyph, title, sub, buttons) {
    var mm = mod(m || 'primary');
    var a = el('div', 'sui-message-system-alert ' + mm);
    var ic = el('div', 'sui-message-system-alert-icon-container');
    if (glyph) ic.appendChild(icon(glyph, 'sui-icon-md'));
    a.appendChild(ic);
    var tx = el('div', 'sui-message-system-alert-text-container');
    if (title != null) {
      var t = el('span', 'sui-text-label' + (TITLE_TONE[mm] ? ' ' + TITLE_TONE[mm] : ''));
      if (typeof title === 'object') t.appendChild(title); else t.textContent = String(title);
      tx.appendChild(t);
    }
    if (sub != null) {
      var s = el('span', 'sui-text-hint');
      if (typeof sub === 'object') s.appendChild(sub); else s.textContent = String(sub);
      tx.appendChild(s);
    }
    a.appendChild(tx);
    var cl = el('div', 'sui-message-system-alert-close-container');
    (buttons || []).forEach(function (b) { if (b) cl.appendChild(b); });
    if (cl.childNodes.length) a.appendChild(cl);
    return a;
  }

  // ── Disabled ────────────────────────────────────────────────────────────
  // A <button> uses the native :disabled; an anchor control (the modal's CTAs,
  // as the game draws them) takes sui-mod-disabled and drops out of the tab
  // order. Either way SUI draws the disabled colour — never an opacity.
  function setDisabled(node, on) {
    if (!node) return;
    if (node.tagName === 'BUTTON' || node.tagName === 'INPUT' || node.tagName === 'SELECT') {
      node.disabled = !!on;
      return;
    }
    node.classList.toggle('sui-mod-disabled', !!on);
    if (on) { node.setAttribute('aria-disabled', 'true'); node.setAttribute('tabindex', '-1'); }
    else { node.removeAttribute('aria-disabled'); node.removeAttribute('tabindex'); }
  }
  function isDisabled(node) {
    return !!node.disabled || node.classList.contains('sui-mod-disabled');
  }

  // ── System modal ────────────────────────────────────────────────────────
  // The game's SystemModal: a scrim, a frame with the left rail and its glyph,
  // the title and body, then one wrapper per call to action.
  //
  // `o`: {
  //   icon:     icon-* name in the rail (default icon-attention),
  //   title:    string or node,
  //   body:     [nodes] (or one node),
  //   ctas:     [{ id, text, mod, icon, disabled, onClick(event, api) }] (anchors) — none: no CTA row;
  //             a CTA without onClick cancels,
  //   variant:  'fixed' (default — SUI's viewport overlay) | 'scrim'
  //             (sp-scrim: absolute inside a positioned parent; the consumer
  //             sets the z-index),
  //   onCancel: called on a backdrop click or Escape (default: close),
  //   className: extra classes on the overlay,
  //   parent:   where to mount it (default document.body).
  // }
  // Returns { overlay, close, buttons } — buttons are the CTA anchors in order.
  function modal(o) {
    o = o || {};
    // Focus goes back where it came from when the modal closes.
    var opener = document.activeElement;
    var ov = el('div', 'sui-message-system-model-overlay'
      + (o.variant === 'scrim' ? ' sp-scrim' : '')
      + (o.className ? ' ' + o.className : ''));
    var box = el('div', 'sui-message-system-modal');
    var frame = el('div', 'sui-message-system-modal-frame');
    var left = el('div', 'sui-message-system-modal-frame-left');
    left.appendChild(el('div', 'sui-message-system-modal-frame-left-top'));
    var mid = el('div', 'sui-message-system-modal-frame-left-middle');
    mid.appendChild(icon(o.icon || 'icon-attention', 'sui-icon-md'));
    left.appendChild(mid);
    left.appendChild(el('div', 'sui-message-system-modal-frame-left-bottom'));
    frame.appendChild(left);

    var center = el('div', 'sui-message-system-model-frame-center');
    var stack = el('div', 'sp-modal-body');
    if (o.title != null) {
      var h = el('h2', 'sui-text-header');
      if (typeof o.title === 'object') h.appendChild(o.title); else h.textContent = String(o.title);
      stack.appendChild(h);
    }
    var body = o.body == null ? [] : (Array.isArray(o.body) ? o.body : [o.body]);
    body.forEach(function (n) { if (n) stack.appendChild(n); });
    center.appendChild(stack);
    frame.appendChild(center);
    box.appendChild(frame);

    var closed = false;
    function close() {
      if (closed) return;
      closed = true;
      var i = OPEN.indexOf(entry);
      if (i >= 0) OPEN.splice(i, 1);
      var a = document.activeElement;
      var hadFocus = !a || a === document.body || ov.contains(a);
      if (ov.parentNode) ov.parentNode.removeChild(ov);
      if (hadFocus && opener && opener !== document.body && opener.isConnected && opener.focus) opener.focus();
    }
    function cancel() { if (o.onCancel) o.onCancel(); else close(); }
    var api = { overlay: ov, close: close, buttons: [] };
    var entry = { overlay: ov, cancel: cancel };

    var ctas = o.ctas || [];
    if (ctas.length) {
      var row = el('div', 'sui-message-system-modal-cta');
      ctas.forEach(function (c) {
        var w = el('div', 'sui-message-system-modal-cta-btn-wrapper');
        // An ANCHOR, as the game's SystemModal draws it. Disabled is
        // sui-mod-disabled (setDisabled), which SUI styles on anchors.
        var b = el('a', 'sui-screen-btn ' + mod(c.mod || 'secondary'));
        b.href = 'javascript:void(0)';
        if (c.id) b.id = c.id;
        if (c.icon) b.appendChild(icon(c.icon, 'sui-icon-md'));
        b.appendChild(el('span', null, c.text == null ? '' : String(c.text)));
        setDisabled(b, !!c.disabled);
        // A CTA with no handler of its own is a Cancel.
        b.addEventListener('click', function (e) {
          if (isDisabled(b)) return;
          if (c.onClick) c.onClick(e, api); else cancel();
        });
        w.appendChild(b);
        row.appendChild(w);
        api.buttons.push(b);
      });
      box.appendChild(row);
    }

    ov.appendChild(box);
    ov.addEventListener('click', function (e) { if (e.target === ov) cancel(); });
    // Tab stays inside a modal dialog.
    ov.addEventListener('keydown', function (e) {
      if (e.key !== 'Tab' || ov.getAttribute('aria-modal') !== 'true') return;
      var f = Array.prototype.filter.call(ov.querySelectorAll('a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])'),
        function (n) { return !n.disabled && n.offsetParent !== null; });
      if (!f.length) return;
      var first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });
    OPEN.push(entry);
    bindEscape();
    (o.parent || document.body).appendChild(ov);
    return api;
  }
  // Escape cancels the TOPMOST open modal only — one listener for all of
  // them, so two stacked dialogs do not both close on one key. It is caught
  // before anything else sees it: a drawer under the modal must not close too.
  var OPEN = [];
  var escapeBound = false;
  function bindEscape() {
    if (escapeBound) return;
    escapeBound = true;
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape' && e.key !== 'Esc') return;
      // A modal removed by someone else's code (innerHTML wipe) is not open.
      while (OPEN.length && !OPEN[OPEN.length - 1].overlay.isConnected) OPEN.pop();
      if (!OPEN.length) return;
      e.stopPropagation();
      e.preventDefault();
      OPEN[OPEN.length - 1].cancel();
    }, true);
  }

  window.SUIParts = {
    el: el,
    checkbox: checkbox, stepper: stepper, selectBox: selectBox, textBox: textBox, field: field,
    radioRows: radioRows, badge: badge, inlineAlert: inlineAlert, systemAlert: systemAlert,
    modal: modal, setDisabled: setDisabled,
  };
})();
