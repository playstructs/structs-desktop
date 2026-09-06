// chat-connection.js: the sign-in ladder, identity, sharing — driven with a
// stub invoke.
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import assert from 'node:assert/strict';

const src = fs.readFileSync(new URL('../../frontend/chat-connection.js', import.meta.url), 'utf8');
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

function boot(state = {}, fixtures = {}) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'outside-only' });
  const w = dom.window;
  w.eval(src);
  const calls = [];
  const S = Object.assign({ guildId: '0-1', started: true, networks: [{ guild_id: '0-1', homeserver: 'https://m', logged_in: true }], steps: [], profile: { user_id: '@1-194:m', display_name: 'Marklifer', avatar_published: true } }, state);
  const el = (tag, cls, text) => { const n = w.document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const ctx = {
    el,
    icon: (name, size) => { const n = w.document.createElement('i'); n.className = size ? name + ' ' + size : name; return n; },
    invoke: (cmd, args) => { calls.push([cmd, args]); return Promise.resolve(fixtures[cmd]); },
    go: (v) => calls.push(['go', v]),
    pageHeader: (label) => el('div', 'hdr', label),
    headerResources: () => null,
    noticeBlock: (t, d, isError) => el('div', 'notice' + (isError ? ' error' : ''), t + ' ' + d),
    render: () => calls.push(['render']),
    showError: (m) => calls.push(['showError', m]),
    activeNetwork: () => S.networks[0] || null,
    connect: () => calls.push(['connect']),
    reconnect: () => calls.push(['reconnect']),
    S, Chat: {},
  };
  return { w, cn: w.ChatConnection(ctx), calls, S };
}

// 1. The ladder: one glyph per state, detail only when there is one.
{
  const { cn } = boot();
  const done = cn.stepRow({ state: 'done', label: 'Guild API' });
  assert.ok(done.classList.contains('chat-mod-done') && done.querySelector('.icon-success'));
  const failed = cn.stepRow({ state: 'failed', label: 'OIDC', detail: '401' });
  assert.ok(failed.querySelector('.icon-alert') && /401/.test(failed.textContent));
  assert.ok(cn.stepRow({ label: 'later' }).querySelector('.icon-unknown'), 'no state is todo');
  assert.equal(cn.kv('Player', null).textContent, 'Player—', 'absence is a dash, not "null"');
}

// 2. Nothing is known until the first status lands; no server is its own message.
{
  assert.ok(/Connecting/.test(boot({ started: false }).cn.renderConnection().textContent));
  const none = boot({ networks: [] }).cn.renderConnection();
  assert.ok(/No comms server/.test(none.textContent) && !none.querySelector('button'), 'nothing to retry against');
}

// 3. Signed in: identity rows and a Reconnect, never a Sign out.
{
  const { cn } = boot();
  const page = cn.renderConnection();
  assert.ok(/Marklifer/.test(page.textContent) && /Published/.test(page.textContent));
  const btns = [...page.querySelectorAll('button')].map((b) => b.id);
  assert.equal(JSON.stringify(btns), JSON.stringify(['chat-reconnect']));
  assert.ok(!/Sign out/i.test(page.textContent));
}

// 4. Not signed in, not connecting: Try again, and the error as a notice.
{
  const { cn, calls } = boot({ networks: [{ guild_id: '0-1', homeserver: 'https://m', logged_in: false }], error: 'token rejected', steps: [{ state: 'failed', label: 'MAS' }] });
  const page = cn.renderConnection();
  assert.ok(page.querySelector('.notice.error') && /token rejected/.test(page.textContent));
  page.querySelector('#chat-retry').click();
  assert.ok(calls.some((c) => c[0] === 'connect'));
}

// 5. Sharing what you are doing is off unless asked, and the toggle asks Rust.
{
  const { cn, calls, S } = boot({ sharingStatus: false }, { matrix_status_sharing: { enabled: true, status: 'Fleet away' } });
  const row = cn.statusSharingRow();
  assert.ok(/Not shared/.test(row.textContent) && /Share/.test(row.querySelector('a').textContent));
  assert.ok(/undefended/.test(row.querySelector('a').title), 'the row says exactly what turning it on reveals');
  row.querySelector('a').click();
  await tick(5);
  assert.equal(JSON.stringify(calls.find((c) => c[0] === 'matrix_status_sharing')[1]), JSON.stringify({ guildId: '0-1', enabled: true }));
  assert.equal(S.sharingStatus, true); assert.equal(S.myStatus, 'Fleet away');
}

console.log('chat-connection: all checks passed');
