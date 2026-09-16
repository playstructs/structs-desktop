// The replicant readout on the game HUD (structs-config.js).
//
// No jsdom harness exists for structs-config.js — it is wired into the game's
// own DOM — so, like debugtab.test.mjs, these are STRUCTURAL checks of the
// rules that matter: it lives in the HUD's own container with the HUD's own
// classes, it is never shown without replicants, and a click opens the
// Replication card and nothing else.
import { readFileSync } from 'fs';

let failures = 0;
const check = (label, ok, detail) => {
  if (ok) { console.log('  ok ' + label); return; }
  failures++;
  console.log('FAIL ' + label + (detail ? ' — ' + detail : ''));
};

const src = readFileSync(process.cwd() + '/frontend/structs-config.js', 'utf8');
const start = src.indexOf('// ── Replicants on the game HUD');
check('the HUD block exists', start > 0);
const block = src.slice(start, src.indexOf('} else if (!window.__STRUCTS_CONFIG__)', start));

check('it is appended into the game\'s own #hud-container, never the body',
  /getElementById\('hud-container'\)/.test(block) && /hud\.appendChild\(el\)/.test(block) && !/document\.body\.appendChild/.test(block));
check('it is drawn as a status-bar panel of resources, like the two corners',
  /sui-status-bar-panel status-bar-panel-top-center/.test(block) && /class="sui-resource"/.test(block));
check('it sits top-centre at the corners\' own offset',
  /top:2px;left:50%;transform:translateX\(-50%\)/.test(block));
check('the three figures: the droid head for replicants, Alpha per day, the CPU glyph for hashing',
  /res\('sui-icon-players', 'replicants'/.test(block) && /res\('sui-icon-alpha-matter', 'alpha_day'/.test(block) && /res\('icon-computer', 'cpu'/.test(block));
check('no replicants, no panel — the whole panel hides with the count, before any figure is written',
  /el\.classList\.toggle\('hidden', n <= 0\);\s*if \(n <= 0\) return;/.test(block));
check('it starts hidden, so it never flashes before the first read',
  /status-bar-panel-top-center hidden'/.test(block));
check('a click opens the Replication card window and nothing else',
  /invoke\('open_terminal_card_new', \{ kind: 'replication', params: \{\} \}\)/.test(block)
    && (block.match(/TAURI\.core\.invoke\(/g) || []).length === 2 && /invoke\('terminal_replication'\)/.test(block));
check('the read is the card\'s own read, so the HUD and the card cannot disagree', /terminal_replication/.test(block));
check('a HUD re-render puts it back', /new MutationObserver/.test(block) && /observe\(hud, \{ childList: true \}\)/.test(block));
check('Alpha is on the game\'s ladder, per day', /fmtAlpha\(day\)/.test(block) && /\* 24/.test(block) && /'\/d'/.test(block));
check('a failed read keeps the last figures instead of blanking the HUD', /catch\(function \(\) \{[\s\S]*ensure\(\);[\s\S]*\}\)/.test(block) && !/last = null;\s*paint/.test(block.slice(block.indexOf('catch'))));

console.log(failures ? failures + ' failing check(s)' : 'all checks passed');
process.exit(failures ? 1 : 0);
