// Guild membership on the Terminal: the Members card's Requests / Invites /
// History tabs, the player's own invites, and a guild's one way in.
//
//   bash scripts/make_harness.sh && node scripts/harness-tests/membership.test.mjs
//
// Fixtures (make_harness.sh): 1-194 is a plain member of 0-1 and owns 0-6,
// which takes requests — one waiting (NOVA), one invite out (ORBIT).
import { JSDOM } from 'jsdom';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const harness = resolve(repo, 'frontend', '_harness.html');
if (!existsSync(harness)) { console.error('missing frontend/_harness.html — run: bash scripts/make_harness.sh'); process.exit(2); }

let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? '  ok ' : 'FAIL ') + name + (ok || detail == null ? '' : ' — ' + detail));
  if (!ok) failures++;
}
async function until(fn, ms = 6000) {
  const t0 = Date.now();
  for (;;) { const v = fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await new Promise((r) => setTimeout(r, 50)); }
}

const dom = await JSDOM.fromFile(harness, { url: pathToFileURL(harness).href + '?view=terminal', runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true });
const w = dom.window, d = w.document;
await until(() => d.querySelectorAll('#tm-grid .tm-card').length >= 1 && d.getElementById('tm-cmd'));
const cmd = d.getElementById('tm-cmd');
const run = (line) => { cmd.value = line; cmd.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); };
const calls = (name) => (w.__HARNESS_CALLS__ || []).filter((c) => c.cmd === name);
const last = (type) => [...d.querySelectorAll('#tm-grid [data-type="' + type + '"]')].slice(-1)[0];
const button = (root, re) => [...root.querySelectorAll('a')].find((a) => re.test(a.textContent.trim()));

// ── A guild that takes requests, seen by its owner ─────────────────────────
run('MEMBERS 0-6');
await until(() => /NOVA/.test((last('members') || {}).textContent || ''));
let mem = last('members');
check('the card opens on Requests when someone waits and you can answer', /Requests 1/.test(mem.textContent) && /NOVA/.test(mem.textContent), mem.textContent.slice(0, 300));
check('…naming the applicant\'s guild, draw and how long they have waited',
  /in 0-1/.test(mem.textContent) && /draws/.test(mem.textContent) && /waiting/.test(mem.textContent), mem.textContent.slice(0, 400));
check('…and the share each member keeps with one more admitted', /share/.test(mem.textContent) && /→/.test(mem.textContent));
check('the policy reads as a word, not bypass levels', /by request/.test(mem.textContent));
const approve = button(mem, /^Approve$/);
check('a request offers Approve and Deny', !!approve && !!button(mem, /^Deny$/));
if (approve) approve.click();
await until(() => d.querySelector('.ops-modal-overlay'));
const sign = [...d.querySelectorAll('.ops-modal-overlay a, .ops-modal-overlay button')].find((b) => /^sign$/i.test(b.textContent.trim()));
check('Approve confirms before anything is signed', !!sign && calls('terminal_guild_admin').length === 0);
if (sign) sign.click();
await until(() => calls('terminal_guild_admin').length);
const signed = calls('terminal_guild_admin')[0];
check('…and signs the approve for that player in that guild',
  !!signed && signed.args.action === 'approve' && signed.args.args.player === '1-42' && signed.args.guildId === '0-6', JSON.stringify(signed && signed.args));

// Tabs.
const tab = (re) => [...last('members').querySelectorAll('.sui-screen-nav-item')].find((a) => re.test(a.textContent));
tab(/^Invites/).click();
await until(() => /ORBIT/.test(last('members').textContent));
mem = last('members');
check('Invites lists the invite out with Withdraw, and an Invite door', /ORBIT/.test(mem.textContent) && !!button(mem, /^Withdraw$/) && !!button(mem, /^Invite$/));
tab(/^History/).click();
await until(() => /1-50/.test(last('members').textContent));
check('History lists what was decided', /1-50 · request approved/.test(last('members').textContent), last('members').textContent.slice(0, 300));
tab(/^Roster/).click();
await until(() => last('members').querySelector('.pc-row') && /JPEG/.test(last('members').textContent));
check('Roster is still the people, quietest last', /JPEG/.test(last('members').textContent));

// A frame about an application re-reads the open card.
const before = calls('terminal_guild_membership').length;
w.__HARNESS_EMIT__('guild-membership', { guild_id: '0-6', player_id: '1-88', join_type: 'request', status: 'proposed' });
await until(() => calls('terminal_guild_membership').length > before);
check('a guild-membership event refreshes the Members card', calls('terminal_guild_membership').length > before);

// ── A guild where you cannot answer: Roster first, no buttons ─────────────
run('MEMBERS 0-1');
await until(() => /JPEG/.test((last('members') || {}).textContent || ''));
mem = last('members');
check('a guild you cannot answer for opens on the Roster', /JPEG/.test(mem.textContent) && !button(mem, /^Approve$/));
tab(/^Requests/).click();
await until(() => /Requests closed/.test(last('members').textContent));
check('…and a closed route says so', /Requests closed/.test(last('members').textContent));

// ── Your own applications ─────────────────────────────────────────────────
run('INVITES');
await until(() => /Iron Tide/.test((last('guildinbox') || {}).textContent || ''));
const inbox = last('guildinbox');
check('INVITES shows invites to you with Accept and Decline', /Invites to you/.test(inbox.textContent) && !!button(inbox, /^Accept$/) && !!button(inbox, /^Decline$/));
check('…what the move does to your power', /power/.test(inbox.textContent) && /→/.test(inbox.textContent));
check('…and your requests, with Withdraw and an offline warning where it applies',
  /Your requests/.test(inbox.textContent) && !!button(inbox, /^Withdraw$/) && /offline after joining/.test(inbox.textContent));
button(inbox, /^Accept$/).click();
await until(() => calls('terminal_guild_admin_preview').some((c) => c.args.action === 'accept_invite'));
check('Accept previews accept_invite for that guild', calls('terminal_guild_admin_preview').some((c) => c.args.action === 'accept_invite' && c.args.guildId === '0-9'));
const overlay = d.querySelector('.ops-modal-overlay');
if (overlay) [...overlay.querySelectorAll('a, button')].find((b) => /cancel|close|✕/i.test(b.textContent))?.click();

// ── A guild's way in ──────────────────────────────────────────────────────
run('JOIN 0-9');
await until(() => /Ask to join/.test((last('guild') || {}).textContent || ''));
let gc = last('guild');
check('JOIN opens the guild with the door its policy offers', !!button(gc, /^Ask to join$/), gc.textContent.slice(0, 300));
check('…and what joining does to your power, in amber when it would leave you offline',
  /your power/.test(gc.textContent) && /offline after joining/.test(gc.textContent) && !!gc.querySelector('.tm-join .sui-text-warning'));
run('GUILD 0-2');
await until(() => button(last('guild'), /^Join$/));
check('an open guild offers Join', !!button(last('guild'), /^Join$/));
run('GUILD 0-3');
await until(() => /hand it over first/.test((last('guild') || {}).textContent || ''));
gc = last('guild');
const blocked = button(gc, /^Join$/);
check('an owner\'s Join is shown but disabled, with the reason', !!blocked && blocked.classList.contains('sui-mod-disabled') && /you own 0-6/.test(gc.textContent));
run('GUILD 0-1');
await until(() => button(last('guild'), /^Members$/));
check('a guild you belong to shows no join door, and leads to its Members', !button(last('guild'), /^Join$|^Ask to join$/) && !!button(last('guild'), /^Members$/));

// ── Words ─────────────────────────────────────────────────────────────────
const T = w.Board.Terminal;
check('REQUESTS / INVITES / JOIN are words', T.WORDS.REQUESTS[0] === 'members' && T.WORDS.INVITES[0] === 'guildinbox' && T.WORDS.JOIN[0] === 'guild');
check('every new card keeps the card SDK contract', ['members', 'guildinbox'].every((t) => { const ty = T.types().find((x) => x.type === t); return ty && !(ty.sdkErrors || []).length; }));

console.log(failures ? `\n${failures} FAILED` : '\nall membership checks passed');
process.exit(failures ? 1 : 0);
