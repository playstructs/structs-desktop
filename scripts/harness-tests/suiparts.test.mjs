// The shared SUI parts module (frontend/sui-parts.js), on its own.
//
// One builder per SUI part. Team Ops' Board.helpers are aliases of these and
// the Battle Simulator builds from them, so a regression here shows in both.
//
//   node scripts/harness-tests/suiparts.test.mjs
import { JSDOM } from 'jsdom';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(resolve(repo, p), 'utf8');

let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? '  ok ' : 'FAIL ') + name + (ok || detail == null ? '' : ' — ' + detail));
  if (!ok) failures++;
}

const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' });
const w = dom.window;
w.eval(read('frontend/sui-parts.js'));
const SP = w.SUIParts;
const d = w.document;
const click = (n) => n.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
const key = (k) => d.dispatchEvent(new w.KeyboardEvent('keydown', { key: k, bubbles: true }));

check('window.SUIParts is published', !!SP);
check('…with every builder',
  ['checkbox', 'stepper', 'selectBox', 'textBox', 'field', 'radioRows', 'badge', 'inlineAlert', 'systemAlert', 'modal']
    .every((k) => typeof SP[k] === 'function'));

{
  console.log('\n— stepper');
  const seen = [];
  const s = SP.stepper(2, { min: 1, max: 3 }, (v) => seen.push(v));
  d.body.appendChild(s);
  const [down, input, up] = s.children;
  check('the wrapper is a DIV, never a span', s.tagName === 'DIV' && s.classList.contains('sui-input-stepper'));
  check('SUI order: button, number input, button',
    down.tagName === 'BUTTON' && input.type === 'number' && up.tagName === 'BUTTON');
  check('the buttons are secondary screen buttons with md game icons',
    down.className === 'sui-screen-btn sui-mod-secondary' && !!down.querySelector('i.sui-icon.sui-icon-md.icon-subtract')
    && !!up.querySelector('i.sui-icon.sui-icon-md.icon-add'));
  check('neither button is disabled inside the range', !down.disabled && !up.disabled);
  click(up);
  check('up steps to the max and disables itself', input.value === '3' && up.disabled && !down.disabled, input.value);
  click(up);
  check('…and a further step is clamped', input.value === '3' && seen[seen.length - 1] === 3);
  input.value = '-40';
  input.dispatchEvent(new w.Event('change'));
  check('a typed value below the min clamps to the min', input.value === '1' && down.disabled && !up.disabled, input.value);
  const f = SP.stepper(0.1, { min: 0, max: 1, step: 0.1 }, () => {});
  f.lastChild.click(); f.lastChild.click();
  check('float steps round to the step precision', f.children[1].value === '0.3', f.children[1].value);
}

{
  console.log('\n— field');
  const ctl = [SP.stepper(1, {}, () => {}), SP.selectBox('b', ['a', 'b'], () => {}),
    SP.textBox('x', 'hint', () => {}), SP.checkbox(true, null, () => {})];
  const fields = ctl.map((c, i) => SP.field('Label ' + i, c));
  check('every field is label.sui-input-text', fields.every((f) => f.tagName === 'LABEL' && f.className === 'sui-input-text'));
  check('the only span child is the caption', fields.every((f) =>
    [...f.children].filter((c) => c.tagName === 'SPAN').length === 1 && f.firstChild.tagName === 'SPAN'));
  check('no control is wrapped in, or is, a span', fields.every((f) => f.children[1].tagName !== 'SPAN'
    && f.children[1].parentNode === f));
  check('the select is bare and keeps its value', ctl[1].tagName === 'SELECT' && !ctl[1].className && ctl[1].value === 'b');
  const bare = SP.field('', ctl[0]);
  check('an empty label draws no caption', !bare.querySelector(':scope > span') && bare.firstChild === ctl[0]);
  const hinted = SP.field('Engine', SP.selectBox('auto', ['auto'], () => {}), 'CPU only', { className: 'cfg-field' });
  const tip = hinted.querySelector('span > a[data-sui-tooltip]');
  check('a hint is a tooltip trigger with its own id', !!tip && tip.id && tip.getAttribute('data-sui-tooltip') === 'CPU only');
  check('…separated from the caption by a no-break space', hinted.firstChild.textContent === 'Engine ');
  check('opts.className adds to the wrapper', hinted.className === 'sui-input-text cfg-field');
}

{
  console.log('\n— radio rows');
  const picks = [];
  const list = SP.radioRows('enc', [
    { value: 'easy', label: 'Easy', checked: true },
    { value: 'random', label: 'Random', trail: SP.badge('Hard', 'warning') },
    { value: 'off', label: 'Off', disabled: true },
  ], (v) => picks.push(v));
  d.body.appendChild(list);
  const rows = [...list.children];
  check('a result table of result rows, as a radiogroup',
    list.className === 'sui-result-table sui-result-rows' && list.getAttribute('role') === 'radiogroup'
    && rows.every((r) => r.tagName === 'LABEL' && r.classList.contains('sui-result-row') && r.classList.contains('sp-choice')));
  check('each row leads with the game radio, then the caption',
    rows.every((r) => r.children[0].className === 'sui-radio-container'
      && r.children[0].children[0].matches('input.sui-radio[type=radio][name=enc]')
      && r.children[0].children[1].className === 'sui-radio-display'
      && r.children[1].matches('span.sui-text-label')));
  check('the trailing node goes last', rows[1].lastChild.matches('span.sui-badge.sui-mod-warning'));
  check('checked and disabled are carried', rows[0].querySelector('input').checked && rows[2].querySelector('input').disabled);
  click(rows[1]);
  check('a click on a row picks it, once', picks.join() === 'random' && rows[1].querySelector('input').checked, picks.join());
  click(rows[1]);
  check('re-clicking the already-checked row fires again', picks.join() === 'random,random', picks.join());
  click(rows[1].querySelector('.sui-text-label'));
  check('…from its caption too', picks.join() === 'random,random,random', picks.join());
  click(rows[2]);
  check('a disabled row does not pick', picks.length === 3 && !rows[2].querySelector('input').checked);
}

{
  console.log('\n— badge and alerts');
  check('badge: span.sui-badge with its modifier', SP.badge('Live', 'destructive').outerHTML === '<span class="sui-badge sui-mod-destructive">Live</span>');
  check('badge defaults to sui-mod-default', SP.badge('Lobby').className === 'sui-badge sui-mod-default');
  const warn = SP.inlineAlert('warning', 'Charge is low.');
  check('inline warning: attention glyph, md, and the text block',
    warn.className === 'sui-message-inline-alert sui-mod-warning'
    && !!warn.querySelector(':scope > i.sui-icon.sui-icon-md.icon-attention')
    && warn.querySelector(':scope > div.sui-message-inline-alert-text').textContent === 'Charge is low.');
  const bad = SP.inlineAlert('destructive', 'No fleet.');
  check('inline destructive: alert glyph', bad.classList.contains('sui-mod-destructive') && !!bad.querySelector('.icon-alert'));
  const close = d.createElement('a');
  const sa = SP.systemAlert('destructive', 'icon-alert', 'Post failed', 'Room not found', [close]);
  check('system alert: the modifier on the alert, three containers',
    sa.className === 'sui-message-system-alert sui-mod-destructive'
    && !!sa.querySelector('.sui-message-system-alert-icon-container > i.sui-icon-md.icon-alert')
    && !!sa.querySelector('.sui-message-system-alert-text-container')
    && sa.querySelector('.sui-message-system-alert-close-container').firstChild === close);
  check('…title is a toned label, sub is hint text',
    sa.querySelector('.sui-text-label').className === 'sui-text-label sui-text-destructive'
    && sa.querySelector('.sui-text-hint').textContent === 'Room not found');
  check('…a primary title is primary-toned',
    SP.systemAlert('primary', 'icon-success', 'Posted', null).querySelector('.sui-text-label').classList.contains('sui-text-primary'));
}

{
  console.log('\n— system modal');
  let cancelled = 0, went = 0;
  const m = SP.modal({
    icon: 'icon-deploy', title: 'End battle?', body: [d.createTextNode('The run is lost.')],
    ctas: [{ id: 'm-no', text: 'Cancel', mod: 'secondary' },
      { id: 'm-go', text: 'End battle', mod: 'destructive', icon: 'icon-close', onClick: (e, api) => { went++; api.close(); } }],
    onCancel: () => { cancelled++; },
  });
  const ov = m.overlay;
  check('it is SystemModal markup, mounted on the body',
    ov.parentNode === d.body && ov.className === 'sui-message-system-model-overlay'
    && !!ov.querySelector(':scope > .sui-message-system-modal > .sui-message-system-modal-frame'));
  check('the left rail carries the glyph',
    !!ov.querySelector('.sui-message-system-modal-frame-left-middle > i.sui-icon.sui-icon-md.icon-deploy')
    && !!ov.querySelector('.sui-message-system-modal-frame-left-top')
    && !!ov.querySelector('.sui-message-system-modal-frame-left-bottom'));
  check('title h2.sui-text-header, then the body, in sp-modal-body',
    ov.querySelector('.sui-message-system-model-frame-center > .sp-modal-body > h2.sui-text-header').textContent === 'End battle?'
    && ov.querySelector('.sp-modal-body').textContent === 'End battle?The run is lost.');
  const btns = [...ov.querySelectorAll('.sui-message-system-modal-cta > .sui-message-system-modal-cta-btn-wrapper > a')];
  check('the api lists the CTAs in order', m.buttons.length === 2 && m.buttons[0] === btns[0] && m.buttons[1] === btns[1]);
  check('one wrapper per CTA, a screen-button anchor (as SystemModal) with its modifier and a span label',
    btns.length === 2 && btns[0].className === 'sui-screen-btn sui-mod-secondary' && btns[0].id === 'm-no'
    && btns[1].className === 'sui-screen-btn sui-mod-destructive'
    && btns[1].children[0].matches('i.sui-icon.sui-icon-md.icon-close') && btns[1].children[1].matches('span')
    && btns[1].textContent === 'End battle');
  click(ov.querySelector('.sui-message-system-modal-frame'));
  check('a click inside the frame is not a cancel', cancelled === 0);
  click(ov);
  check('a backdrop click calls onCancel', cancelled === 1);
  key('Enter');
  check('another key does nothing', cancelled === 1);
  key('Escape');
  check('Escape calls onCancel', cancelled === 2);
  SP.setDisabled(btns[0], true);
  click(btns[0]);
  check('a disabled CTA is sui-mod-disabled and inert',
    cancelled === 2 && btns[0].classList.contains('sui-mod-disabled') && btns[0].getAttribute('aria-disabled') === 'true');
  SP.setDisabled(btns[0], false);
  click(btns[0]);
  check('a CTA without onClick cancels', cancelled === 3 && ov.isConnected && !btns[0].classList.contains('sui-mod-disabled'));
  click(btns[1]);
  check('a CTA click fires its onClick, whose api closes the modal', went === 1 && !ov.isConnected);
  key('Escape');
  check('a closed modal no longer hears Escape', cancelled === 3);

  const plain = SP.modal({ title: 'Deploy', ctas: [] });
  check('no CTAs: no CTA row', !plain.overlay.querySelector('.sui-message-system-modal-cta'));
  check('the rail defaults to icon-attention', !!plain.overlay.querySelector('.icon-attention'));
  const top = SP.modal({ title: 'On top' });
  key('Escape');
  check('without onCancel, Escape closes — only the topmost', !top.overlay.isConnected && plain.overlay.isConnected);
  click(plain.overlay);
  check('…and a backdrop click closes it', !plain.overlay.isConnected);

  const host = d.createElement('div');
  d.body.appendChild(host);
  const sc = SP.modal({ title: 'Paused', variant: 'scrim', parent: host, className: 'sim-scrim' });
  check('the scrim variant mounts in its parent with sp-scrim',
    sc.overlay.parentNode === host && sc.overlay.classList.contains('sp-scrim') && sc.overlay.classList.contains('sim-scrim'));
  sc.close(); sc.close();
  check('close is idempotent', !sc.overlay.isConnected);
}

{
  console.log('\n— Team Ops is an alias, not a copy');
  const board = read('frontend/board.js');
  for (const name of ['checkbox', 'stepper', 'selectBox', 'textBox']) {
    check(`board.js has no body of its own for ${name}`, !new RegExp('function ' + name + '\\s*\\(').test(board));
  }
  check('board.js field and confirmModal delegate to SUIParts',
    /SP\.field\(/.test(board) && /SP\.modal\(/.test(board) && /window\.SUIParts/.test(board));
  const html = read('frontend/board.html');
  const at = (s) => html.indexOf(s);
  check('board.html loads sui-parts.js before board.js',
    at('src="sui-parts.js"') > 0 && at('src="sui-parts.js"') < at('src="board.js"'));
  check('board.html loads sui-parts.css', at('href="sui-parts.css"') > 0);
}

{
  console.log('\n— compact radio rows are opt-in');
  const css = read('frontend/sui-parts.css');
  // Every rule that trims a row hangs off .sp-compact / .sp-tiles, so a list
  // radioRows builds (Team Ops' included) keeps SUI's full rows unless asked.
  const rules = [...css.matchAll(/([^{}]+)\{[^}]*\}/g)].map((m) => m[1].replace(/\/\*[\s\S]*?\*\//g, '').trim());
  const compact = rules.filter((sel) => /sp-compact|sp-tiles/.test(sel));
  check('sui-parts.css has the compact and tile rules', compact.length >= 5);
  check('…and each of them is scoped to the opt-in classes', compact.every((sel) => sel.split(',').every((x) => /\.sp-(compact|tiles)\b/.test(x))));
  const board = read('frontend/board.js');
  check('Team Ops does not opt in', !/sp-compact|sp-tiles/.test(board));
}

console.log(failures ? `\n${failures} failing check(s)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
