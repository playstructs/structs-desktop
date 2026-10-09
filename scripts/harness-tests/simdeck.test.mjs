// The Command Deck component layer: frontend/simdeck.js (window.SimDeck) and
// frontend/simdeck.css, the builders every Battle Simulator screen is made of.
//
//   node scripts/harness-tests/simdeck.test.mjs
//
// 1. House rules on the source: DOM only, no literals, tokens only.
// 2. Every builder in jsdom: roles, roving radio groups, the battery's range
//    input updating in place, the rank, the menu wiring, the modal stack,
//    the timeline's positions and the stat lines.
// 3. Coverage: every d-* class the builders emit has a rule in simdeck.css,
//    and simdeck.css keeps SUI's scale, type sizes and square corners.
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(resolve(repo, p), 'utf8');
let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? '  ok ' : 'FAIL ') + name + (ok || detail == null ? '' : ' — ' + detail));
  if (!ok) failures++;
}
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/(^|[^:'"])\/\/.*$/, '$1')).join('\n');
const JS = read('frontend/simdeck.js');
const CSS = read('frontend/simdeck.css');

/* ── 1. The source ─────────────────────────────────────────────────────── */
{
  console.log('\n— the source');
  const src = strip(JS);
  check('simdeck.js builds no HTML strings', !/innerHTML|insertAdjacentHTML|outerHTML/.test(src));
  check('…has no px literal', !/\dpx/.test(src), (src.match(/.{20}\dpx.{10}/) || [''])[0]);
  check('…no hex or rgba colour', !/#[0-9A-Fa-f]{3,8}(?![0-9A-Za-z_-])|\b(?:rgba?|hsla?)\(/.test(src));
  check('…and never writes a var(--d-*) local (those live only in simdeck.css)', !/var\(--d-/.test(src));
  check('…and documents every builder it exports in its header',
    (() => {
      const head = JS.slice(0, JS.indexOf('(function'));
      const names = [...JS.slice(JS.indexOf('window.SimDeck = {')).matchAll(/(\w+): \1\b/g)].map((m) => m[1]).filter((n) => n !== n.toUpperCase());
      const missing = names.filter((n) => !new RegExp('\\b' + n + '\\(').test(head));
      return names.length > 40 && missing.length === 0 || (console.log('     undocumented:', missing.join(', ')), false);
    })());
}

/* ── 2. The builders ───────────────────────────────────────────────────── */
const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only', pretendToBeVisual: true });
const w = dom.window, d = w.document;
for (const f of ['battle-art.js', 'pfp.js', 'simdeck.js']) w.eval(read('frontend/' + f));
const D = w.SimDeck;
const click = (n) => n.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
const key = (n, k, extra = {}) => n.dispatchEvent(new w.KeyboardEvent('keydown', Object.assign({ key: k, bubbles: true, cancelable: true }, extra)));

{
  console.log('\n— foundations');
  const g = D.glyph('raid', 16), s = D.sprite('land', 32);
  check('glyph: i.sui-icon.icon-NAME.d-gly.is-16, aria-hidden', g.matches('i.sui-icon.icon-raid.d-gly.is-16') && g.getAttribute('aria-hidden') === 'true');
  check('sprite: i.sui-icon.sui-icon-NAME.d-ico.is-32, aria-hidden', s.matches('i.sui-icon.sui-icon-land.d-ico.is-32') && s.getAttribute('aria-hidden') === 'true');
  check('…default size 24 adds no size class', D.glyph('add').className === 'sui-icon icon-add d-gly');
  const sh = D.ship('cruiser', 64, { foe: true, dead: true, skull: true });
  const srcs = [...sh.querySelectorAll('img')].map((i) => i.getAttribute('src'));
  check('ship: layers bottom → base → top from BattleArt', srcs.join() === 'img/structs/cruiser/cruiser-bottom-ripples.png,img/structs/cruiser/cruiser-struct-base.png,img/structs/cruiser/cruiser-top-weapon-ballistic.png,img/structs/cruiser/cruiser-top-weapon-smart.png', srcs.join());
  check('…tagged for the game\'s z order, alt="" and not draggable',
    sh.querySelector('img.struct-bottom-detail') && sh.querySelectorAll('img.struct-top-detail').length === 2 && [...sh.querySelectorAll('img')].every((i) => i.alt === '' && i.draggable === false));
  check('…foe, dead and the skull', sh.matches('span.d-ship.is-64.is-foe.is-dead') && !!sh.querySelector('i.sui-icon-destroyed.d-ship-x[aria-hidden=true]'));
  const p = D.pf('{"background":3,"arms":12,"body":21,"neck":4,"head":33}', { size: 24, tone: 'you' });
  check('portrait: StructsPfp layers in a span.d-pf.is-24.is-you', p.matches('span.d-pf.is-24.is-you') && p.querySelectorAll('img.pfp-viewer-layer').length === 5);
  check('…junk attrs draw the placeholder, never markup', D.pf('<img onerror=x>').querySelector('img').getAttribute('src') === 'img/portrait-placeholder.png');
  check('…the computer is a glyph, not a portrait', D.pf(null, { cpu: true }).matches('.d-pf.is-cpu') && !!D.pf(null, { cpu: true }).querySelector('.icon-computer'));
  check('led tones', D.led().className === 'd-led' && D.led('amber', true).className === 'd-led is-amber is-lg');
  const c = D.chevs(2);
  check('chevrons list top to bottom and light from the bottom', [...c.children].map((x) => x.classList.contains('is-lit') ? 1 : 0).join('') === '011');
  check('brackets carry the kind', D.brackets('enemy', true).className === 'd-brackets d-bracket-enemy is-sm');
  const into = d.createElement('div'); into.id = 'keep'; into.setAttribute('data-x', '1'); into.textContent = 'old';
  D.panel({ into, tone: 'enemy', title: 'Computer' });
  check('opts.into fills an element in place, keeping id and attributes', into.id === 'keep' && into.dataset.x === '1' && into.classList.contains('d-panel') && into.classList.contains('is-enemy') && !/old/.test(into.textContent));
  D.panel({ into, tone: 'player', title: 'You' });
  check('…and a refill drops the state classes it added last time', into.classList.contains('is-player') && !into.classList.contains('is-enemy'));
  const pn = D.panel({ title: 'Mission', glyph: 'planet', right: ['4'], foot: [D.btn({ text: 'Go' })] });
  check('panel: header, right slot, body and footer', pn.root.matches('section.d-panel') && pn.head.matches('header.d-panel-h') && pn.right.textContent === '4' && pn.body.matches('.d-panel-b') && pn.foot.matches('footer.d-panel-f'));
}

{
  console.log('\n— keys');
  const sq = D.btn({ glyph: 'range', square: true, tone: 'teal', ariaLabel: 'Pick on board' });
  check('a square btn carries aria-label and title', sq.getAttribute('aria-label') === 'Pick on board' && sq.title === 'Pick on board' && sq.matches('button.d-btn.is-teal.is-sq[type=button]'));
  const ib = D.iconBtn({ glyph: 'close', label: 'Stop guarding' });
  check('iconBtn carries aria-label and title', ib.getAttribute('aria-label') === 'Stop guarding' && ib.title === 'Stop guarding' && ib.querySelector('i').getAttribute('aria-hidden') === 'true');
  let n = 0;
  const b = D.btn({ text: 'Go', onClick: () => n++ });
  D.btn({ into: b, text: 'Go', onClick: () => n++ });
  click(b);
  check('refilling a key does not double its click handler', n === 1, n);
  const l = D.launch({ text: 'Start battle', id: 'start' });
  check('launch: span label then the chevron glyph', l.id === 'start' && l.firstChild.tagName === 'SPAN' && l.firstChild.textContent === 'Start battle' && l.lastChild.matches('.icon-chevron-right'));
  const k = D.key({ ability: 'defend', glyph: 'defend', caption: 'Guard', title: 'Guard', pressed: true });
  check('key: data-ability, aria-pressed, title', k.dataset.ability === 'defend' && k.getAttribute('aria-pressed') === 'true' && k.title === 'Guard');
}

function radioGroupChecks(label, api, buttons, attr, picks, firstValue) {
  check(label + ': role radiogroup', api.root.getAttribute('role') === 'radiogroup');
  const tabbable = () => buttons().filter((b) => b.tabIndex === 0).length;
  check(label + ': only one tabindex=0', tabbable() === 1, tabbable());
  const current = buttons().find((b) => b.getAttribute(attr) === 'true');
  click(current);
  check(label + ': clicking the CURRENT option still picks', picks[picks.length - 1] === current.dataset.value, picks.join());
  click(buttons()[0]);
  check(label + ': ' + attr + ' toggles', buttons()[0].getAttribute(attr) === 'true' && buttons().filter((b) => b.getAttribute(attr) === 'true').length === 1);
  buttons()[0].focus();
  key(buttons()[0], 'ArrowRight');
  check(label + ': ArrowRight moves focus and picks', d.activeElement === buttons()[1] && picks[picks.length - 1] === buttons()[1].dataset.value && buttons()[1].tabIndex === 0);
  key(buttons()[1], 'Home');
  check(label + ': Home picks the first', picks[picks.length - 1] === firstValue && d.activeElement === buttons()[0]);
  check(label + ': still one tabindex=0', tabbable() === 1);
}

{
  console.log('\n— mission cards');
  const picks = [];
  const api = D.cards({ label: 'Encounter', current: 'difficult', onPick: (v) => picks.push(v), items: [
    { value: 'easy', label: 'Easy', count: 4, rank: 1 }, { value: 'difficult', label: 'Difficult', count: 8, rank: 2 },
    { value: 'hard', label: 'Hard', count: 12, rank: 3 }, { value: 'random', label: 'Random', count: '6–16', dice: true },
  ] });
  d.body.appendChild(api.root);
  const bs = () => [...api.root.querySelectorAll('button.d-card')];
  check('cards are radio buttons with aria-checked and the friendly brackets', bs().length === 4 && bs().every((b) => b.type === 'button' && b.getAttribute('role') === 'radio' && b.hasAttribute('aria-checked') && !b.hasAttribute('aria-pressed') && b.querySelector('.d-brackets.d-bracket-friendly')));
  check('Random: the dice and no count sprite; ranked cards: chevrons', !!bs()[3].querySelector('.icon-refresh-12') && !bs()[3].querySelector('.d-ico') && bs()[2].querySelectorAll('.d-chev.is-lit').length === 3);
  radioGroupChecks('cards', api, bs, 'aria-checked', picks, 'easy');
  api.set('hard');
  check('set() moves the check and the tab stop', bs()[2].getAttribute('aria-checked') === 'true' && bs()[2].tabIndex === 0);
}

{
  console.log('\n— segmented switch');
  const picks = [];
  const api = D.seg({ label: 'Block time', current: '2000', onPick: (v) => picks.push(v), options: [
    { value: 2000, label: '2 s', sub: 'training' }, { value: 6000, label: '6 s', sub: 'chain' }] });
  d.body.appendChild(api.root);
  const bs = () => [...api.root.querySelectorAll('button.d-seg-opt')];
  check('options are buttons with a sub line', bs().length === 2 && bs()[0].querySelector('.d-seg-sub').textContent === 'training');
  radioGroupChecks('seg', api, bs, 'aria-checked', picks, '2000');
  check('seg options are radios', bs().every((b) => b.getAttribute('role') === 'radio' && !b.hasAttribute('aria-pressed')));
}

{
  console.log('\n— charge battery');
  const got = [], done = [];
  const b = D.battery({ id: 'charge-player', label: 'You', value: 9, mark: 5, ariaLabel: 'Your opening charge', onInput: (v) => got.push(v), onChange: (v) => done.push(v) });
  d.body.appendChild(b.root);
  const input = b.input;
  check('a real range input 0..30 keeping opts.id', input.matches('input.d-batt-range[type=range]#charge-player') && input.min === '0' && input.max === '30' && input.getAttribute('aria-label') === 'Your opening charge');
  check('thirty cells in six groups of five', b.root.querySelectorAll('.d-cell').length === 30 && b.root.querySelectorAll('.d-cell-g').length === 6);
  check('mark puts .is-mark on cell 5', b.root.querySelectorAll('.d-cell')[4].classList.contains('is-mark') && b.root.querySelectorAll('.d-cell.is-mark').length === 1);
  input.value = '12';
  input.dispatchEvent(new w.Event('input', { bubbles: true }));
  const cells = [...b.root.querySelectorAll('.d-cell')];
  check('input 12: twelve cells lit, cell 12 is the head', cells.filter((c) => c.classList.contains('is-lit')).length === 12 && cells[11].classList.contains('is-head') && b.root.querySelectorAll('.d-cell.is-head').length === 1);
  check('…the value screen reads 12 and onInput heard it', b.root.querySelector('.d-batt-val').textContent === '12' && got[got.length - 1] === 12);
  check('…and the input element is the same one (painted in place)', b.input === input && b.root.querySelector('input') === input && input.isConnected);
  input.dispatchEvent(new w.Event('change', { bubbles: true }));
  check('a keyboard change reaches onChange', done[done.length - 1] === 12);
  b.set({ value: 99 });
  check('set({value: 99}) clamps to 30', input.value === '30' && b.root.querySelectorAll('.d-cell.is-lit').length === 30 && b.value() === 30);
  b.set({ disabled: true, hint: 'fixed by challenge' });
  check('disabled locks the input and dims the control', input.disabled && b.root.classList.contains('is-disabled') && b.root.querySelector('.d-batt-hint').textContent === 'fixed by challenge');
  const ro = D.battery({ readout: true, slim: true, label: 'Opening charge', value: 9 });
  check('a readout has no input and is role=img with its value', !ro.root.querySelector('input') && ro.input === null && ro.root.getAttribute('role') === 'img' && /Opening charge opening charge 9/.test(ro.root.getAttribute('aria-label')));
  check('mirror and foe classes', D.battery({ readout: true, mirror: true, side: 'foe' }).root.matches('.d-battery.is-mirror.is-foe.is-readout'));
}

{
  console.log('\n— rank');
  const picks = [];
  const r = D.rank({ id: 'ai-level', level: 'difficult', onPick: (v) => picks.push(v) });
  d.body.appendChild(r.root);
  const pips = [...r.root.querySelectorAll('button.d-pip')];
  check('three role=radio pips in a radiogroup with data-value', pips.length === 3 && pips.every((p) => p.getAttribute('role') === 'radio') && r.root.id === 'ai-level' && r.root.dataset.value === 'difficult' && r.root.getAttribute('aria-label') === 'Opponent skill');
  check('lit up to the level, the word follows', pips.map((p) => +p.classList.contains('is-lit')).join('') === '110' && r.root.querySelector('.d-rank-word').textContent === 'Difficult');
  click(pips[2]);
  check('clicking Hard: data-value, aria-checked and onPick', r.root.dataset.value === 'hard' && pips[2].getAttribute('aria-checked') === 'true' && pips[1].getAttribute('aria-checked') === 'false' && picks.join() === 'hard');
  pips[2].focus(); key(pips[2], 'ArrowLeft');
  check('arrows move and pick', r.root.dataset.value === 'difficult' && d.activeElement === pips[1]);
  r.set(null, true);
  click(pips[0]);
  check('disabled blocks it', r.root.dataset.value === 'difficult' && picks.length === 2 && r.root.classList.contains('is-disabled'));
}

{
  console.log('\n— menu');
  const fired = [];
  let focusAtHandler = null, hiddenAtHandler = null;
  const opener = D.tool({ text: 'Share', glyph: 'link-out', caret: true });
  const m = D.menu({ label: 'Share', items: [
    { id: 'm-post', text: 'Post to…', onClick: () => fired.push('post') }, { id: 'm-copy', text: 'Copy link', disabled: true },
    { id: 'm-hid', text: 'Hidden', hidden: true }, { id: 'm-paste', text: 'Paste', onClick: () => { fired.push('paste'); focusAtHandler = d.activeElement; hiddenAtHandler = m.hidden; } },
    { sep: true }, { id: 'm-live', text: 'Live', hidden: true }] });
  const box = d.createElement('div'); box.className = 'd-menu-anchor'; box.append(opener, m); d.body.appendChild(box);
  const api = D.bindMenu(opener, m);
  check('wires aria-haspopup / aria-controls / aria-expanded and hides the menu', opener.getAttribute('aria-haspopup') === 'menu' && opener.getAttribute('aria-controls') === m.id && opener.getAttribute('aria-expanded') === 'false' && m.hidden);
  check('binding twice returns the same handle', D.bindMenu(opener, m) === api);
  click(opener);
  check('click opens: aria-expanded, first enabled item focused', api.isOpen() && opener.getAttribute('aria-expanded') === 'true' && d.activeElement.id === 'm-post');
  check('…a separator with only hidden items after it is hidden', m.querySelector('.d-menu-sep').hidden);
  key(d.activeElement, 'ArrowDown');
  check('ArrowDown skips disabled and .hidden items', d.activeElement.id === 'm-paste', d.activeElement.id);
  key(d.activeElement, 'Escape');
  check('Escape closes and focuses the opener', !api.isOpen() && d.activeElement === opener && opener.getAttribute('aria-expanded') === 'false');
  click(opener);
  click(m.querySelector('#m-paste'));
  check('an item click runs its handler and closes', fired.join() === 'paste' && !api.isOpen());
  check('…closed first, focus back on the opener, so a dialog it opens returns focus there', hiddenAtHandler === true && focusAtHandler === opener);
  click(opener);
  d.body.dispatchEvent(new w.Event('pointerdown', { bubbles: true }));
  check('an outside pointerdown closes', !api.isOpen());
  click(opener); click(opener);
  check('click toggles', !api.isOpen());
  // A STATIC menu (markup already in the page) binds the same way.
  const sb = d.createElement('button'); sb.type = 'button';
  const sm = d.createElement('div'); sm.className = 'd-menu';
  const si = d.createElement('button'); si.className = 'd-menu-item'; si.type = 'button'; sm.appendChild(si);
  d.body.append(sb, sm);
  const sapi = D.bindMenu(sb, sm);
  click(sb);
  check('a static menu gets an id, role=menu and opens', !!sm.id && sm.getAttribute('role') === 'menu' && sapi.isOpen() && d.activeElement === si);
  sapi.close();
}

{
  console.log('\n— modal');
  const before = d.createElement('button'); before.textContent = 'before'; d.body.appendChild(before); before.focus();
  const cancel = D.btn({ text: 'Cancel' }), go = D.launch({ text: 'Resume', auto: true });
  const body = d.createElement('div'); body.id = 'paused-body'; body.className = 'hidden'; d.body.appendChild(body);
  let cancelled = 0;
  const m = D.modal({ id: 'paused', title: 'Paused', titleId: 'paused-t', meta: '01:42', metaId: 'paused-clock', body, cta: [cancel, go], focus: go, kept: true, width: 'md', onCancel: (h) => { cancelled++; h.hide(); } });
  check('a hidden scrim with the dialog inside', m.overlay.matches('div.d-scrim.hidden#paused') && m.dialog.matches('.d-modal.is-md') && m.overlay.parentNode === d.body);
  check('the body node is MOVED in, keeps its id, loses hidden', m.body.firstChild === body && body.id === 'paused-body' && !body.classList.contains('hidden'));
  check('meta keeps its id', d.getElementById('paused-clock') === m.metaEl && m.metaEl.textContent === '01:42');
  m.show();
  check('show(): role, aria-modal, aria-labelledby the title', m.dialog.getAttribute('role') === 'dialog' && m.dialog.getAttribute('aria-modal') === 'true' && m.dialog.getAttribute('aria-labelledby') === 'paused-t' && d.getElementById('paused-t') === m.titleEl);
  check('…focuses opts.focus and is the open modal', d.activeElement === go && D.modalOpen() === m && !m.overlay.classList.contains('hidden'));
  key(d, 'Tab');
  check('Tab from the last control wraps to the first', d.activeElement === cancel);
  key(d, 'Tab', { shiftKey: true });
  check('Shift+Tab from the first wraps to the last', d.activeElement === go);
  const inner = D.btn({ text: 'OK' });
  const top = D.modal({ title: 'End battle?', tone: 'warn', cta: [inner] });
  top.show();
  check('a second modal is on top and focused', D.modalOpen() === top && d.activeElement === inner);
  key(d, 'Escape');
  check('Escape cancels only the top one (default: close)', !top.isOpen() && !top.overlay.isConnected && m.isOpen() && cancelled === 0 && D.modalOpen() === m);
  check('…and focus returns into the one below', d.activeElement === go);
  key(d, 'Escape');
  check('Escape on the kept one calls its onCancel', cancelled === 1 && !m.isOpen() && D.modalOpen() === null);
  check('hide() restores the focus from before', d.activeElement === before);
  check('kept: hide() keeps the DOM', m.overlay.isConnected && m.overlay.classList.contains('hidden'));
  m.show();
  check('kept re-show works', m.isOpen() && !m.overlay.classList.contains('hidden') && d.activeElement === go && D.modalOpen() === m);
  m.close();
  check('close() removes it', !m.overlay.isConnected && D.modalOpen() === null);
  const st = D.modal({ title: 'Saved', role: 'status' });
  st.show();
  check('role=status: no aria-modal, no trap, no focus move', st.dialog.getAttribute('role') === 'status' && !st.dialog.hasAttribute('aria-modal') && D.modalOpen() === null && d.activeElement === before);
  st.close();
  let bd = 0;
  const back = D.modal({ title: 'x', backdropCancels: true, onCancel: () => bd++ });
  back.show();
  back.dialog.dispatchEvent(new w.Event('pointerdown', { bubbles: true }));
  back.overlay.dispatchEvent(new w.Event('pointerdown', { bubbles: true }));
  check('backdropCancels: only a pointerdown on the scrim itself cancels', bd === 1);
  back.close();
}

{
  console.log('\n— board');
  const t = D.tile({ side: 'foe', slug: 'tank', target: true, hp: [2, 3], defended: true, label: 'Enemy Tank, in reach' });
  check('tile: a button with its label, ship mirrored, reticle and brackets', t.matches('button.d-tile.is-foe.is-target[type=button]') && t.getAttribute('aria-label') === 'Enemy Tank, in reach'
    && !!t.querySelector('.d-ship.is-foe') && !!t.querySelector('.d-reticle.icon-range') && !!t.querySelector('.d-brackets') && t.querySelectorAll('.d-hp .d-hp-s.is-off').length === 1 && !!t.querySelector('.d-marks .sui-icon-defended'));
  const e = D.tile({ empty: true, slotOn: true });
  check('an empty slot has the plus and s-slot-on', e.matches('.d-tile.is-empty.s-slot-on') && !!e.querySelector('.d-tile-plus.icon-add') && !e.querySelector('.d-ship'));
  const s = D.tile({ static: true, size: 56, slug: 'battleship', dead: true, label: 'Battleship, lost' });
  check('a static tile is a span role=img with a 48 ship and the skull', s.matches('span.d-tile.is-static.is-56.is-dead[role=img]') && !!s.querySelector('.d-ship.is-48.is-dead') && !!s.querySelector('.d-tile-badge.sui-icon-destroyed'));
  const r = D.reach({ space: true, land: true, water: true });
  check('reach: four sprites in order, unreached ones off, a spoken label', [...r.children].map((i) => i.className.match(/sui-icon-(\w+)/)[1] + (i.classList.contains('is-off') ? '-' : '')).join() === 'space,air-,land,water' && r.getAttribute('aria-label') === 'Reaches space, land and water');
  const sc = []; const card = D.structCard({ slug: 'frigate', ambit: 'space', name: 'Frigate', hp: 2, dmg: 1, current: true, onShow: (x) => sc.push(x) });
  card.dispatchEvent(new w.Event('mouseenter'));
  check('struct card: art, name, stat, aria-current, onShow(slug)', card.matches('button.d-card.is-struct[aria-current=true]') && !!card.querySelector('.d-card-art.d-t-space .d-ship') && /1 dmg/.test(card.textContent) && sc.join() === 'frigate');
  const gd = D.guard({ ward: { slug: 'command_ship', name: 'Command Ship' } });
  check('guard: ward, × Stop guarding and the Pick key', gd.root.matches('.d-guard') && gd.clear.getAttribute('aria-label') === 'Stop guarding' && gd.pick.getAttribute('aria-label') === 'Pick on board' && gd.pick.getAttribute('aria-pressed') === 'false');
  check('guard picking / empty', D.guard({ picking: true }).root.matches('.d-guard.is-picking') && /Not guarding anyone/.test(D.guard({}).root.textContent));
  const wpn = D.weapon({ kind: 'smart', name: 'Guided', dmg: 2, cost: 5, reach: ['land', 'water'] });
  check('weapon: smart glyph, cost cells, reach "Hits land and water"', !!wpn.querySelector('.icon-smart-weapon') && wpn.querySelector('.d-mini').getAttribute('aria-label') === 'Costs 5 charge' && wpn.querySelector('.d-reach.is-bare').getAttribute('aria-label') === 'Hits land and water');
}

{
  console.log('\n— debrief');
  const tl = D.timeline({ n: 76, events: [
    { block: 19, side: 'you', slug: 'tank', label: 'First kill' }, { block: 24, side: 'you', slug: 'tank', label: 'Tank' },
    { block: 50, side: 'them', slug: 'cruiser', label: 'Cruiser' }, { block: 76, side: 'you', slug: 'battleship', label: 'Victory', kill: true }] });
  const evs = [...tl.querySelectorAll('.d-tl-ev')];
  check('block 19 of 76 sits at left 25%', evs[0].style.left === '25%', evs[0].style.left);
  check('ends read 0 and N, ticks at quarters', [...tl.querySelectorAll('.d-tl-end')].map((x) => x.textContent).join() === '0,76' && [...tl.querySelectorAll('.d-tl-tick')].map((x) => x.style.left).join() === '25%,50%,75%');
  check('a close same-side event staggers, its neighbour leads', evs[1].classList.contains('is-stagger') && evs[0].classList.contains('is-lead') && !evs[2].classList.contains('is-stagger') && !evs[3].classList.contains('is-stagger'));
  check('captions read B<block>; kills get the skull', evs[0].querySelector('.d-tl-blk').textContent === 'B19' && !!evs[3].querySelector('.d-tl-skull') && evs[3].classList.contains('is-kill'));
  check('their events are mirrored ships', evs[2].matches('.is-them') && !!evs[2].querySelector('.d-ship.is-foe'));
  const st = D.stats({ head: { you: 'You', them: 'Them' }, rows: [{ sprite: 'destroyed', label: 'Structs lost', you: 1, them: 0 }, { glyph: 'dmg', glyphTone: 'gold', label: 'Damage', you: 0, them: 3 }] });
  const vals = [...st.querySelectorAll('.d-stat:not(.is-head) .d-stat-v')];
  check('a zero value gets .is-zero, others do not', vals.map((v) => +v.classList.contains('is-zero')).join('') === '0110');
  check('stat icons: sprite at 32, toned glyph', !!st.querySelector('.d-stat-ic .sui-icon-destroyed.is-32') && !!st.querySelector('.d-stat-ic .icon-dmg.is-gold'));
  const v = D.verdict({ word: 'Victory', reason: 'Computer command ship destroyed', wordId: 'verdict', reasonId: 'verdict-why', facts: [{ text: 'Blocks', n: 76 }], factsId: 'verdict-facts' });
  check('verdict: h1#verdict word, reason and facts ids', v.matches('.d-verdict') && v.querySelector('h1.d-verdict-t#verdict').textContent === 'Victory' && !!v.querySelector('#verdict-why') && !!v.querySelector('.d-facts#verdict-facts'));
  check('defeat / draw tones', D.verdict({ word: 'Defeat', tone: 'defeat' }).classList.contains('is-defeat') && D.verdict({ word: 'Draw', tone: 'draw' }).classList.contains('is-draw'));
  const lad = D.ladder([{ rank: 1, name: 'Marklifer', time: '02:41', won: true, me: true }, { rank: 2, name: 'JPEG', time: '03:00', won: false }]);
  check('ladder: ol.d-ladder of li.d-lrow, won teal ✓ / lost coral ×', lad.matches('ol.d-ladder') && lad.children.length === 2 && lad.children[0].matches('.is-me') && !!lad.children[0].querySelector('.icon-success.is-teal') && !!lad.children[1].querySelector('.d-lrow-t.d-coral'));
  const cp = D.composer({ placeholder: 'Reply' });
  check('composer: portrait, input, teal square Send', cp.root.matches('.d-composer') && cp.input.matches('input.d-composer-in') && cp.send.matches('button.d-btn.is-teal.is-sq[aria-label=Send]'));
  const al = D.alert({ tone: 'amber', head: 'New best', detail: 'x', sub: 'y' });
  check('alert: tone, led, head, detail, sub', al.matches('.d-alert.is-amber') && !!al.querySelector('.d-led.is-amber') && al.querySelector('.d-alert-h').textContent === 'New best');
  const md = D.mode(d.createElement('span'), { tone: 'challenge', text: 'Challenge' });
  check('mode badge: challenge glyph', md.matches('.d-mode.is-challenge') && !!md.querySelector('.icon-raid'));
  const pl = D.pill({ text: 'Block 51', tone: 'teal', led: true, id: 'blk' });
  check('pill: tone, led, id', pl.matches('span.d-pill.is-teal#blk') && !!pl.querySelector('.d-led'));

  // W3: the parts the screens had been hand-patching.
  const bare = D.mini(3, { bare: true });
  check('mini bare: the meter alone, aria-hidden, no number', bare.getAttribute('aria-hidden') === 'true' && !bare.hasAttribute('role') && !bare.querySelector('.d-mini-n')
    && bare.querySelectorAll('.d-mini-c.is-lit').length === 3);
  const own = D.sprite('land');
  const st2 = D.stats({ rows: [{ ic: own, label: 'Land', you: 3, them: 2 }, { ic: bare, label: 'Charge', you: 9, them: 9 }] });
  check('stats: a row\'s ic is any node, placed in its icon cell', st2.querySelectorAll('.d-stat-ic')[0].firstChild === own && st2.querySelectorAll('.d-stat-ic')[1].firstChild === bare);
  const seat = D.lrow({ seat: true, name: 'JPEG', pill: D.pill({ text: 'Ready', tone: 'teal' }) });
  check('lrow seat: face, name, pill — no rank, no verdict', seat.matches('li.d-lrow.is-seat') && seat.children.length === 3 && !seat.querySelector('.d-lrow-n, .d-lrow-t')
    && seat.children[0].matches('.d-pf') && seat.children[1].matches('.d-lrow-name') && seat.children[2].matches('.d-pill'));
  check('…and the seat grid has its own rule', /\.d-lrow\.is-seat\s*\{[^}]*grid-template-columns/.test(CSS));

  const row = d.createElement('div');
  d.body.appendChild(row);
  const items = [0, 1, 2].map(() => row.appendChild(d.createElement('span')));
  Object.defineProperty(row, 'clientWidth', { configurable: true, get: () => 100 });
  items.forEach((n, i) => {
    Object.defineProperty(n, 'offsetLeft', { configurable: true, get: () => i * 45 });
    Object.defineProperty(n, 'offsetWidth', { configurable: true, get: () => 40 });
  });
  D.fitRow(row);
  check('fitRow: whole items or none — the one past the edge and every one after it go', items.map((n) => n.style.display).join('|') === '||none');
  Object.defineProperty(row, 'clientWidth', { configurable: true, get: () => 200 });
  D.fitRow(row);
  check('…and come back when there is room', items.every((n) => n.style.display === ''));

  const box = d.createElement('div');
  d.body.appendChild(box);
  const tl2 = D.timeline({ into: box, n: 100, events: [{ block: 50, side: 'you', slug: 'tank', label: 'A' }, { block: 52, side: 'you', slug: 'tank', label: 'B' }, { block: 99, side: 'them', slug: 'tank', label: 'C' }] });
  const caps = [...tl2.querySelectorAll('.d-tl-cap')];
  const R = (l, r) => () => ({ left: l, right: r, width: r - l, top: 0, bottom: 10, height: 10 });
  box.getBoundingClientRect = R(0, 400);
  Object.defineProperty(box, 'offsetWidth', { configurable: true, get: () => 200 });   // the page at 2x
  caps[0].getBoundingClientRect = R(180, 220); caps[1].getBoundingClientRect = R(200, 240); caps[2].getBoundingClientRect = R(380, 420);
  D.fitTimeline(box);
  check('fitTimeline: touching captions on one side ease apart, in layout px (the page\'s 2x halved)', caps[0].style.translate === '-7px' && caps[1].style.translate === '7px', caps.map((c) => c.style.translate).join());
  check('…and one past the panel\'s edge is pulled back inside', caps[2].style.translate === '-10px', caps[2].style.translate);
}

/* ── 3. Coverage and the stylesheet ────────────────────────────────────── */
{
  console.log('\n— coverage');
  const css = strip(CSS);
  const lits = new Set();
  for (const m of strip(JS).matchAll(/'([^'\n]*)'/g)) {
    for (const c of m[1].split(/\s+/)) if (/^d-[a-z0-9-]*[a-z0-9]$/.test(c)) lits.add(c);
  }
  const missing = [...lits].filter((c) => !new RegExp('\\.' + c + '(?![a-z0-9-])').test(css));
  check(`every d-* class simdeck.js emits has a rule (${lits.size})`, lits.size > 60 && missing.length === 0, missing.join(', '));
  check('simdeck.css: no hex or rgba/hsl', !/#[0-9A-Fa-f]{3,8}(?![0-9A-Za-z_-])|\b(?:rgba?|hsla?)\(/.test(css));
  const off = [];
  for (const m of css.matchAll(/\b(padding|margin|gap|row-gap|column-gap)(?:-(?:top|right|bottom|left))?: *([^;'"}\n]+)/g)) {
    for (const v of m[2].matchAll(/(\d+)px/g)) if (!['0', '1', '2', '4', '8', '12', '16', '24', '32'].includes(v[1])) off.push(m[1] + ':' + v[1]);
  }
  check('simdeck.css: spacing on the 0/1/2/4/8/12/16/24/32 scale', off.length === 0, off.join(', '));
  const sizes = [...css.matchAll(/font-size: *(\d+)px/g)].map((m) => m[1]);
  check('simdeck.css: font sizes within 8/12/16/32', sizes.length > 0 && sizes.every((n) => ['8', '12', '16', '32'].includes(n)), [...new Set(sizes)].join());
  check('simdeck.css: square corners', !/border-radius:\s*(?!0\b)[^\s;]/.test(css));
  const roots = [...css.matchAll(/:root\s*\{([^}]*)\}/g)].map((m) => [...m[1].matchAll(/(--[a-z0-9-]+):/g)].map((x) => x[1])).flat();
  check('simdeck.css: :root defines only the --d-* locals', roots.length > 0 && roots.every((t) => t.startsWith('--d-')), roots.join());
  const tokens = new Set([...read('frontend/css/sui/sui.css').matchAll(/(--[a-z0-9-]+):/g)].map((m) => m[1]).concat([...CSS.matchAll(/(--d-[a-z0-9-]+):/g)].map((m) => m[1])));
  const unknown = [...new Set([...css.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]))].filter((t) => !tokens.has(t));
  check('simdeck.css: every var() is a SUI token or a --d-* it defines', unknown.length === 0, unknown.join(', '));
  check('simdeck.css: no var() fallbacks', !/var\(--[a-z0-9-]+,/.test(css));
}

console.log(failures ? `\n${failures} failing check(s)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
