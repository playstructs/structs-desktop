#!/usr/bin/env node
// The chart card: many series on panes, an editor, saved charts with ⌘K
// words, share codes, and alert rules — against the static harness.
//
//   bash scripts/make_harness.sh
//   node scripts/harness-tests/chart.test.mjs
import { JSDOM } from 'jsdom';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const harness = resolve(repo, 'frontend', '_harness.html');
if (!existsSync(harness)) { console.error('missing frontend/_harness.html — run: bash scripts/make_harness.sh'); process.exit(2); }

let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures++;
  console.log((ok ? '  ok ' : 'FAIL ') + name + (ok || detail == null ? '' : ' — ' + detail));
}
const until = async (fn, ms = 6000) => { const t0 = Date.now(); for (;;) { const v = fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await new Promise((r) => setTimeout(r, 25)); } };
const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));

const dom = await JSDOM.fromFile(harness, { url: pathToFileURL(harness).href + '?view=terminal', runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true });
const w = dom.window, d = w.document;
await until(() => w.Board && w.Board.Terminal && w.Board.Terminal.state && w.Board.Terminal.state.layout);
const T = w.Board.Terminal;
const calls = () => w.__HARNESS_CALLS__ || [];
const S = (list) => JSON.stringify(list);

// ── grammar ────────────────────────────────────────────────────────────────
{
  console.log('\n— grammar');
  check('the chart card is registered and filed', T.types().some((t) => t.type === 'chart') && T.groups().some((g) => g.options.some((o) => o.value === 'chart')));
  check('CHART alone is an empty chart', T.parse('CHART').type === 'chart' && !JSON.parse(T.parse('CHART').params.series || '[]').length);
  await until(() => T.charts !== null && w.Board.Terminal.state.layout);
  await tick(200);
  const byId = T.parse('CHART 2-29604');
  check('CHART <planet id> is that planet\'s ore, from the catalogue', byId.type === 'chart' && JSON.parse(byId.params.series)[0].source === 'stat' && JSON.parse(byId.params.series)[0].metric === 'ore' && JSON.parse(byId.params.series)[0].subject === '2-29604', S(byId.params));
  check('…and a provider id is its rate', JSON.parse(T.parse('CHART 10-4').params.series)[0].source === 'provider');
  check('CHART market is the market\'s best rate', JSON.parse(T.parse('CHART market').params.series)[0].source === 'market');
  check('subject first works too', T.parse('2-29604 CHART').type === 'chart' && T.parse('2-29604 HIST').type === 'chart');
}

// ── the card: panes, legend, editor ────────────────────────────────────────
{
  console.log('\n— panes');
  const card = T.add('chart', { series: S([{ source: 'stat', metric: 'ore', subject: '2-29604' }, { source: 'market', metric: 'best' }, { source: 'stat', metric: 'load', subject: '4-1' }]), window: '86400' }, 2);
  const node = await until(() => { const n = d.querySelector('#tm-' + card.id); return n && n.querySelectorAll('.ch-pane').length >= 2 ? n : null; });
  check('three series in three units draw as three panes, never one plot with two axes', node && node.querySelectorAll('.ch-pane').length === 3, node && node.querySelectorAll('.ch-pane').length);
  check('one request carried every series, on one grid', calls().filter((c) => c.cmd === 'terminal_chart_series').slice(-1)[0].args.series.length === 3);
  check('the legend names every series with its last value and a way off', node.querySelectorAll('.ch-legend-item').length === 3 && node.querySelectorAll('.ch-legend-item .ch-x').length === 3 && /Kg|g\b/.test(node.querySelector('.ch-legend-item .ops-val').textContent));
  check('a pane is captioned by its unit', /ore/.test(node.querySelector('.ch-pane .gs-cap').textContent));
  check('the editor offers source, metric, subject and Add', node.querySelector('.ch-editor select') !== null && [...node.querySelectorAll('.ch-editor a')].some((a) => a.textContent === 'Add'));

  check('the window is a strip across the top of the card, the current one marked', node.querySelectorAll('.ch-windows .sui-screen-nav-item').length === 5 && node.querySelector('.ch-windows .sui-mod-active').textContent === '24h');
  check('every series shows how it moved over the window', node.querySelectorAll('.ch-legend-item .ch-delta').length === 3 && /^[+−]\d/.test(node.querySelector('.ch-legend-item .ch-delta').textContent));
  check('a rate is shown at the precision it has, never rounded to a fixed two decimals', T._chartSig(0.005455) === '0.00545' && T._chartSig(12.852) === '12.85' && T._chartSig(16363.6) === '16,364' && T._chartSig(0) === '0' && T._chartSig(2) === '2.00');
  check('capacity for sale is in the chain\'s milliwatts: 2,012,907,666 mW reads as the market card\'s 2.01MW', T._chartFmt('mw', 2012907666) === w.Board.helpers.fmtWatts(2012907666) && /MW/.test(T._chartFmt('mw', 2012907666)), T._chartFmt('mw', 2012907666));
  check('the delta helper: first known reading to last, in percent', T._chartDelta([null, 100, 150]).pct === 50 && T._chartDelta([0, 3]).pct == null && T._chartDelta([0, 3]).abs === 3 && T._chartDelta([null]) === null);
  [...node.querySelectorAll('.ch-windows .sui-screen-nav-item')].find((a) => a.textContent === '7d').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  const wk = await until(() => { const c = T.state.layout.cards.find((x) => x.id === card.id); return c && c.params.window === '604800' ? c : null; });
  const refetched = await until(() => calls().some((c) => c.cmd === 'terminal_chart_series' && c.args.windowS === 604800));
  check('picking 7d in the strip re-draws the card on that window', !!wk && !!refetched);
  await until(() => { const n = d.querySelector('#tm-' + card.id); return n && n.querySelector('.ch-windows .sui-mod-active') && n.querySelector('.ch-windows .sui-mod-active').textContent === '7d' ? n : null; });
  check('…and the strip marks it', d.querySelector('#tm-' + card.id + ' .ch-windows .sui-mod-active').textContent === '7d');

  // Remove one from the legend: the card re-renders with two.
  node.querySelectorAll('.ch-legend-item .ch-x')[1].dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  const two = await until(() => { const n = d.querySelector('#tm-' + card.id); return n && n.querySelectorAll('.ch-legend-item').length === 2 ? n : null; });
  check('removing a series from the legend leaves the other two, colours kept', !!two && JSON.parse(T.state.layout.cards.find((c) => c.id === card.id).params.series).length === 2);

  // Index mode: everything on one pane, in percent.
  T.setParams(card.id, Object.assign({}, T.state.layout.cards.find((c) => c.id === card.id).params, { index: '1' }));
  const one = await until(() => { const n = d.querySelector('#tm-' + card.id); return n && n.querySelectorAll('.ch-pane').length === 1 && /indexed/.test(n.querySelector('.ch-pane .gs-cap').textContent) ? n : null; });
  check('indexed to 100: one pane for everything, captioned as indexed', !!one);
  check('the indexing helper starts every series at 100 and keeps its nulls', S(T._chartIndexed([null, 50, 75, null, 100])) === S([null, 100, 150, null, 200]) && S(T._chartIndexed([0, 0])) === S([null, null]));

  // Modes reach the renderer.
  T.setParams(card.id, Object.assign({}, T.state.layout.cards.find((c) => c.id === card.id).params, { index: '0', mode: 'bars' }));
  const bars = await until(() => { const n = d.querySelector('#tm-' + card.id); return n && n.querySelector('.gs-chart svg rect') ? n : null; });
  check('bars mode draws rects anchored to the floor', !!bars);
  T.setParams(card.id, Object.assign({}, T.state.layout.cards.find((c) => c.id === card.id).params, { mode: 'area' }));
  const area = await until(() => { const n = d.querySelector('#tm-' + card.id); return n && n.querySelectorAll('.gs-chart svg path[fill-opacity]').length ? n : null; });
  check('area mode fills under the line', !!area);
  T.remove(card.id);
}

// ── editor adds a series ────────────────────────────────────────────────────
{
  console.log('\n— editor');
  const card = T.add('chart', { series: '[]' }, 2);
  const node = await until(() => { const n = d.querySelector('#tm-' + card.id); return n && n.querySelector('.ch-editor') ? n : null; });
  const selects = node.querySelectorAll('.ch-editor select');
  selects[0].value = 'market'; selects[0].dispatchEvent(new w.Event('change', { bubbles: true }));
  await tick(30);
  const add = [...d.querySelectorAll('#tm-' + card.id + ' .ch-editor a')].find((a) => a.textContent === 'Add');
  add.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  const drawn = await until(() => { const c = T.state.layout.cards.find((x) => x.id === card.id); return c && JSON.parse(c.params.series).length === 1 ? c : null; });
  check('choosing the market and pressing Add puts its best rate on the chart', !!drawn && JSON.parse(drawn.params.series)[0].source === 'market' && JSON.parse(drawn.params.series)[0].metric === 'best');
  add.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await tick(60);
  check('the same series is not added twice', JSON.parse(T.state.layout.cards.find((x) => x.id === card.id).params.series).length === 1);
  T.remove(card.id);
}

// ── save, word, share, alert ────────────────────────────────────────────────
{
  console.log('\n— save · word · share · alert');
  const card = T.add('chart', { series: S([{ source: 'market', metric: 'best' }]), window: '604800' }, 2);
  await until(() => d.querySelector('#tm-' + card.id + ' .ch-legend'));
  T.chartSaveStrip(card.id);
  const strip = d.querySelector('#tm-' + card.id + ' .ch-strip');
  check('the save door opens a strip with a name and a word', strip && strip.querySelectorAll('input').length === 2);
  strip.querySelectorAll('input')[0].value = 'Market best';
  strip.querySelectorAll('input')[1].value = 'mkt';
  [...strip.querySelectorAll('a')].find((a) => a.textContent === 'Save').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await tick(80);
  const saved = calls().filter((c) => c.cmd === 'terminal_chart_save').slice(-1)[0];
  check('saving sends the name, the upper-cased word and the params', saved && saved.args.name === 'Market best' && saved.args.word === 'mkt' && JSON.parse(saved.args.params.series)[0].source === 'market', S(saved && saved.args));
  check('…and the saved list is what the grammar reads', (T.charts || []).some((c) => c.name === 'Market best' && c.word === 'MKT'));
  check('the word opens it: MKT is that chart', T.parse('MKT').type === 'chart' && T.parse('MKT').params.name === 'Market best' && JSON.parse(T.parse('MKT').params.series)[0].metric === 'best');
  check('so is CHART <name>', T.parse('CHART Market best').params.name === 'Market best');
  check('and the empty palette lists it under Charts', T.suggestFor('').some((r) => r.group === 'Charts' && r.what === 'Market best' && r.words === 'MKT'));
  check('typing the start of its word completes it, ahead of the card words', T.suggestFor('MK')[0].what === 'Market best' && T.suggestFor('MK')[0].line === 'CHART Market best');
  check('so does the start of its name', T.suggestFor('mar').some((r) => r.what === 'Market best') && T.suggestFor('mar').some((r) => r.words === 'MARKET' || /MARKET/.test(r.words)));
  check('CHART <space> lists every saved chart and the library; CHART Mar narrows to the saved one', T.suggestFor('CHART ').length === 1 + T.chartTemplates().length && T.suggestFor('CHART ')[0].what === 'Market best' && T.suggestFor('CHART Mar')[0].what === 'Market best' && T.suggestFor('CHART zzz').length === 0);
  check('a word that starts no chart is unchanged', T.suggestFor('ZZ').length === 0);

  const p = T.state.layout.cards.find((c) => c.id === card.id).params;
  const code = T.exportChart(Object.assign({}, p, { name: 'Market best', word: 'MKT' }));
  const parsed = T.parseShared(code);
  check('a share code round-trips the chart, not a workspace', /^terminal:/.test(code) && parsed && parsed.chart && parsed.chart.name === 'Market best' && parsed.chart.word === 'MKT' && parsed.chart.params.window === '604800');
  const before = T.state.layout.cards.length;
  const ok = await T.importWorkspace(code);
  check('IMPORT of a chart code saves it and opens it as a card', ok === true && T.state.layout.cards.length === before + 1 && T.state.layout.cards.slice(-1)[0].type === 'chart');

  T.chartAlertStrip(card.id);
  const alert = d.querySelector('#tm-' + card.id + ' .ch-strip');
  check('the alert door offers the series, a direction and a value', alert && alert.querySelectorAll('select').length === 2 && alert.querySelector('input'));
  check('the value starts at the series\' last reading, the way a price alert starts at the price', Math.abs(Number(alert.querySelector('input').value) - 2) < 0.2, alert.querySelector('input').value);
  alert.querySelector('input').value = '2';
  [...alert.querySelectorAll('a')].find((a) => a.textContent === 'Watch').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await tick(60);
  const alerts = T.state.layout.cards.find((c) => c.type === 'alerts');
  check('Watch writes a rule on the series\' latest value into the Alerts card', alerts && /series\.market\.best < 2/.test(alerts.params.rules), alerts && alerts.params.rules);
  // The threshold comes back to the chart as a dashed line on that pane.
  T.setParams(card.id, Object.assign({}, T.state.layout.cards.find((c) => c.id === card.id).params));
  const ref = await until(() => { const n = d.querySelector('#tm-' + card.id); return n && n.querySelector('.gs-ref') ? n : null; });
  check('a watched series draws its threshold as a dashed reference line, captioned on the pane', !!ref && /watch 2\.00/.test(ref.querySelector('.ch-refs').textContent), ref && ref.querySelector('.ch-refs') && ref.querySelector('.ch-refs').textContent);
  check('the reference line is part of the band: the axis reaches it', !!ref && Number(ref.querySelector('.gs-ref').getAttribute('y1')) > 0);
  check('the refs helper finds the rule for exactly that series', T._chartRefsFor([{ source: 'market', metric: 'best' }]).length === 1 && T._chartRefsFor([{ source: 'market', metric: 'offers' }]).length === 0);
  const reading = T.readingFor('series.market.best');
  const v = reading ? await reading() : null;
  check('…and the Alerts card can read that series', typeof v === 'number', String(v));
  check('a subject rides in the rule too', T.chartRuleFor({ source: 'stat', metric: 'ore', subject: '2-29604' }) === 'series.stat.ore.2-29604');
  const shown = await until(() => { const n = d.querySelector('#tm-' + alerts.id); const t = n ? n.textContent : ''; return /kW·d/.test(t) ? t : null; });
  check('the Alerts card shows the series reading in its own unit, not a raw float', !!shown && !/\d\.\d{5}/.test(shown), shown && shown.slice(0, 120));
  check('a plain reading loses its noise', T.fmtReading('market.best_rate', 2.0701697876146734) === 2.07 && T.fmtReading('raids.live', 3) === 3 && T.fmtReading('x', 123.456) === 123);
}

// ── the library ────────────────────────────────────────────────────────────
{
  console.log('\n— library');
  T.charts = [];
  const lib = T.chartTemplates();
  check('the library has a chart for the market, providers, my ore, my power, my token, the galaxy and the chain', lib.length >= 9 && ['RATES', 'OFFERS', 'RESERVES', 'LOAD', 'TOKEN', 'GALAXY', 'DEPOSITS', 'PULSE', 'COMBAT'].every((w) => lib.some((t) => t.word === w)));
  check('every word opens its chart and none is shadowed by a card word', lib.every((t) => { const p = T.parse(t.word); return p && p.type === 'chart' && p.params.template === t.word && p.params.name === t.name; }), lib.filter((t) => !(T.parse(t.word) && T.parse(t.word).params && T.parse(t.word).params.template === t.word)).map((t) => t.word).join(','));
  check('words and names are unique', new Set(lib.map((t) => t.word)).size === lib.length && new Set(lib.map((t) => t.name.toLowerCase())).size === lib.length);
  check('CHART <name> opens a template too', T.parse('CHART Energy market').params.template === 'RATES' && T.parse('CHART galaxy').params.template === 'GALAXY');
  const rows = T.suggestFor('').filter((r) => r.group === 'Charts');
  check('the empty palette lists the library under Charts, each under its word', rows.length === lib.length && rows.some((r) => r.words === 'RATES' && r.what === 'Energy market' && r.line === 'CHART Energy market'));
  check('a typed prefix completes a template by word or by name', T.suggestFor('RAT')[0].what === 'Energy market' && T.suggestFor('galaxy o')[0] === undefined && T.suggestFor('CHART galaxy o')[0].what === 'Galaxy ore');
  check('a chart saved under a template\'s word takes the word', (() => { T.charts = [{ name: 'My pulse', word: 'PULSE', params: { series: '[{"source":"chain","metric":"chain_tx"}]' } }]; const ok = T.parse('PULSE').params.name === 'My pulse' && T.suggestFor('').filter((r) => r.words === 'PULSE').length === 1 && T.suggestFor('').some((r) => r.what === 'My pulse'); T.charts = []; return ok; })());

  // Opening one: the roster fills in what is mine, and the card becomes an ordinary chart.
  const mine = T.add('chart', T.chartTemplateParams(T.chartTemplate('RESERVES')), 2);
  const resolved = await until(() => { const c = T.state.layout.cards.find((x) => x.id === mine.id); const list = c ? JSON.parse(c.params.series || '[]') : []; return list.length === 3 && !c.params.template ? c : null; });
  check('RESERVES resolves {player} {planet} {fleet} from the roster and drops the template', !!resolved && JSON.parse(resolved.params.series).map((s) => s.subject).join(' ') === '1-194 2-194 9-194', resolved && resolved.params.series);
  check('…keeps the name and window it was given', !!resolved && resolved.params.name === 'My ore' && resolved.params.window === '604800');
  const drawn = await until(() => { const n = d.querySelector('#tm-' + mine.id); return n && n.querySelector('.ch-legend') ? n : null; });
  check('…and draws', !!drawn);
  T.remove(mine.id);

  const offers = T.add('chart', T.chartTemplateParams(T.chartTemplate('OFFERS')), 2);
  const prov = await until(() => { const c = T.state.layout.cards.find((x) => x.id === offers.id); const list = c ? JSON.parse(c.params.series || '[]') : []; return list.length && !c.params.template ? c : null; });
  check('OFFERS is every provider the catalogue knows, as its rate', !!prov && JSON.parse(prov.params.series).every((s) => s.source === 'provider' && s.metric === 'rate') && JSON.parse(prov.params.series)[0].subject === '10-4');
  T.remove(offers.id);

  const token = await T._chartResolveTemplate(T.chartTemplate('TOKEN'));
  check('TOKEN is my guild\'s token, from the roster\'s guild id', token.length === 3 && token.every((s) => s.source === 'bank' && s.subject === '0-1'), JSON.stringify(token));
  const galaxy = await T._chartResolveTemplate(T.chartTemplate('GALAXY'));
  check('a template with no placeholders resolves without the roster', galaxy.length === 3 && galaxy[0].subject === 'substation');

  // An empty chart offers the library instead of a sentence.
  const empty = T.add('chart', { series: '[]' }, 2);
  const chips = await until(() => { const n = d.querySelector('#tm-' + empty.id); return n && n.querySelectorAll('.ch-templates a').length ? n : null; });
  check('an empty chart shows the library as buttons, one per template', !!chips && chips.querySelectorAll('.ch-templates a').length === lib.length && !chips.querySelector('.sui-message'), chips && chips.querySelectorAll('.ch-templates a').length);
  [...chips.querySelectorAll('.ch-templates a')].find((a) => a.textContent === 'Chain pulse').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  const pulse = await until(() => { const c = T.state.layout.cards.find((x) => x.id === empty.id); return c && JSON.parse(c.params.series || '[]').length === 3 && c.params.name === 'Chain pulse' ? c : null; });
  check('pressing one fills this card with it', !!pulse);
  T.remove(empty.id);
}

// ── migration ──────────────────────────────────────────────────────────────
{
  console.log('\n— migration');
  const parsed = T.parseShared('terminal:' + Buffer.from(JSON.stringify({ name: 'old', cards: [{ id: 'series-1', type: 'series', params: { id: '2-29604', metric: 'load', window: '21600' }, w: 2 }] })).toString('base64'));
  check('a shared workspace naming the old series card is still understood', parsed && parsed.cards.length === 1);
}

console.log(failures ? `\n${failures} failing check(s)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
