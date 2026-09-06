// raidview-hud.js: the HUD panels, the portrait guard, the battery ladder.
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import assert from 'node:assert/strict';

const src = fs.readFileSync(new URL('../../frontend/raidview-hud.js', import.meta.url), 'utf8');
const HTML = '<!doctype html><html><body><span id="rv-where"></span><span id="rv-live"></span><span id="rv-shield"></span><span id="rv-shield-icon"></span><span id="rv-shield-res"></span><span id="rv-ore"></span><span id="rv-energy"></span>'
  + '<div id="rv-def-portrait"></div><div id="rv-def-pfp"></div><div id="rv-def-battery"><i></i><i></i><i></i><i></i><i></i></div>'
  + '<div id="rv-hud-br"><div id="rv-atk-portrait"></div><div id="rv-atk-pfp"></div><div id="rv-atk-battery"><i></i><i></i><i></i><i></i><i></i></div></div></body></html>';

function boot(state, target) {
  const dom = new JSDOM(HTML, { runScripts: 'outside-only' });
  const w = dom.window;
  const calls = [];
  w.StructsPfp = { fillPortrait: (host, attrs) => calls.push(['fill', attrs]) };
  w.eval(src);
  const chat = { myCharge: null };
  const hud = w.RaidHud({ state: () => state, target: () => target, chat: () => chat, paintComposerIdentity: () => calls.push(['identity']) });
  return { w, hud, calls, chat, d: w.document };
}

// 1. The ladder and the formatters.
{
  const { hud } = boot({}, null);
  assert.equal(JSON.stringify([null, 0, 1, 2, 3, 4, 5, 8, 20].map(hud.chargeLevel)), JSON.stringify([0, 0, 1, 2, 3, 4, 4, 5, 5]), 'ChargeCalculator: [0,1,2,3,5,8] → 0-5');
  assert.equal(hud.whoLine('Marklifer', '1-194'), 'Marklifer (1-194)');
  assert.equal(hud.whoLine(null, '1-194'), '1-194'); assert.equal(hud.whoLine(null, null, 'your primary'), 'your primary');
  assert.equal(hud.fmtAge(45000), '45s ago'); assert.equal(hud.fmtAge(720000), '12m ago'); assert.equal(hud.fmtAge(11520000), '3.2h ago');
  assert.equal(hud.humanStatus('shieldsVulnerable'), 'shields vulnerable'); assert.equal(hud.humanStatus('raid_status'), 'raid status');
  assert.equal(hud.fmtNum(1234.6), '1235', 'raw, as the game\'s own HUD shows it');
}

// 2. The portrait guard: same attributes, no repaint; the battery fills by level.
{
  const { hud, calls, d } = boot({}, null);
  const host = d.getElementById('rv-def-pfp');
  hud.paintPfp(host, '{"a":1}'); hud.paintPfp(host, '{"a":1}');
  assert.equal(calls.filter((c) => c[0] === 'fill').length, 1, 'painted once for unchanged attributes');
  hud.paintPfp(host, '{"a":2}');
  assert.equal(calls.filter((c) => c[0] === 'fill').length, 2);
  const bat = d.getElementById('rv-def-battery');
  hud.paintBattery(bat, 3);
  assert.equal(bat.querySelectorAll('.sui-mod-filled').length, 3);
  hud.paintBattery(bat, 0);
  assert.equal(bat.querySelectorAll('.sui-mod-filled').length, 0);
}

// 3. The header: where, liveness by age, the shield's three states, the raider only when there is one.
{
  const snap = { planet_id: '2-1', fetched_at_ms: Date.now(), planetary_shield: 40, raid_status: 'shieldsVulnerable', stored_ore: 7, owner_energy: '12', owner: '1-61', owner_name: 'JPEG', owner_charge: 8, owner_pfp: '{}', viewer_charge: 5 };
  const state = { snapshot: snap, lastEventMs: 0 };
  const { hud, d, chat, calls } = boot(state, { kind: 'planet', id: '2-1' });
  hud.renderHeader();
  assert.equal(d.getElementById('rv-where').textContent, 'PLANET 2-1');
  assert.equal(d.getElementById('rv-live').textContent, 'live');
  assert.equal(d.getElementById('rv-shield').textContent, '40', 'the number appears while vulnerable');
  assert.ok(/shield_vulnerable_raid_enemy/.test(d.getElementById('rv-shield-icon').innerHTML));
  assert.ok(d.getElementById('rv-hud-br').classList.contains('hidden'), 'no raider, no raider bar');
  assert.ok(/JPEG \(1-61\)/.test(d.getElementById('rv-def-portrait').getAttribute('data-sui-tooltip')));
  assert.equal(chat.myCharge, 5); assert.ok(calls.some((c) => c[0] === 'identity'), 'the viewer\'s charge reaches the composer');

  snap.raid_status = null; hud.renderHeader();
  assert.equal(d.getElementById('rv-shield').textContent, '', 'secure: the glyph alone carries the state');
  assert.ok(/shield_secure/.test(d.getElementById('rv-shield-icon').innerHTML));
  snap.planetary_shield = 0; hud.renderHeader();
  assert.ok(/shield_breached/.test(d.getElementById('rv-shield-icon').innerHTML));

  snap.raiding_fleet = '9-4'; snap.raider_id = '1-248'; snap.raider_name = 'Phoniffer'; hud.renderHeader();
  assert.ok(!d.getElementById('rv-hud-br').classList.contains('hidden'));
  assert.ok(/Phoniffer \(1-248\)/.test(d.getElementById('rv-atk-portrait').getAttribute('data-sui-tooltip')));

  snap.fetched_at_ms = Date.now() - 60000; hud.renderHeader();
  assert.ok(/ago$/.test(d.getElementById('rv-live').textContent) && d.getElementById('rv-live').className.includes('stale'));
  snap.fetched_at_ms = Date.now() - 300000; hud.renderHeader();
  assert.ok(d.getElementById('rv-live').className.includes('dead'));
  state.lastEventMs = Date.now(); hud.renderHeader();
  assert.equal(d.getElementById('rv-live').textContent, 'live', 'freshness is the NEWEST of the two signals');
}

// 4. A fleet window says where the fleet is; no snapshot says connecting.
{
  const { hud, d } = boot({ snapshot: null }, { kind: 'fleet', id: '9-4' });
  hud.renderHeader();
  assert.equal(d.getElementById('rv-where').textContent, 'FLEET 9-4 · IN TRANSIT');
  assert.equal(d.getElementById('rv-live').textContent, 'connecting');
  const { hud: h2, d: d2 } = boot({ snapshot: { planet_id: '2-9' } }, { kind: 'fleet', id: '9-4' });
  h2.renderHeader();
  assert.equal(d2.getElementById('rv-where').textContent, 'FLEET 9-4 · AT PLANET 2-9');
}

console.log('raid-hud: all checks passed');
