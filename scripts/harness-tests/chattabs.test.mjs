// chat-tabs.js: the open conversations in the nav slot.
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import assert from 'node:assert/strict';

const src = fs.readFileSync(new URL('../../frontend/chat-tabs.js', import.meta.url), 'utf8');

function boot(state = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div id="menu-page-nav-items"></div><a id="chat-nav-comms"></a><a id="chat-nav-settings"></a></body></html>', { runScripts: 'outside-only' });
  const w = dom.window;
  w.eval(src);
  const calls = [];
  const S = Object.assign({ tabs: [], rooms: [], view: 'room', roomId: null }, state);
  const el = (tag, cls, text) => { const n = w.document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const ctx = {
    el, icon: (n) => el('i', n), byId: (id) => w.document.getElementById(id),
    clear: (n) => { while (n.firstChild) n.removeChild(n.firstChild); },
    render: () => calls.push(['render']), openRoom: (id) => calls.push(['openRoom', id]), go: (v) => calls.push(['go', v]),
    activeNetwork: () => ({ tag: 'SNC' }), S, Chat: {},
  };
  return { w, tb: w.ChatTabs(ctx), calls, S };
}

// 1. Bounded: the oldest goes first, never the one being opened nor the one on screen.
{
  const { tb, S } = boot();
  for (let i = 1; i <= 8; i++) tb.openTab('!' + i);
  S.roomId = '!1';
  tb.openTab('!9');
  assert.equal(S.tabs.length, tb.MAX_TABS);
  assert.equal(JSON.stringify(S.tabs), JSON.stringify(['!1', '!3', '!4', '!5', '!6', '!7', '!8', '!9']), 'the second-oldest went: the oldest is on screen');
  tb.openTab('!9');
  assert.equal(S.tabs.length, 8, 'opening an open tab is idempotent');
}

// 2. Closing the one you are looking at hands you the neighbour; the last one, the channel list.
{
  const { tb, S, calls } = boot({ tabs: ['!a', '!b', '!c'], roomId: '!b' });
  tb.closeTab('!b');
  assert.equal(JSON.stringify(S.tabs), JSON.stringify(['!a', '!c']));
  assert.ok(calls.some((c) => c[0] === 'openRoom' && c[1] === '!c'), 'the right-hand neighbour');
  S.roomId = '!c'; tb.closeTab('!c');
  assert.ok(calls.some((c) => c[0] === 'openRoom' && c[1] === '!a'), 'then the left one');
  S.roomId = '!a'; tb.closeTab('!a');
  assert.ok(calls.some((c) => c[0] === 'go' && c[1] === 'channels'));
  tb.closeTab('!zzz');
  assert.equal(S.tabs.length, 0, 'closing what is not open is nothing');
}

// 3. The strip: the network name when nothing is open; a dot, not a count, for unread.
{
  const { tb, S, w, calls } = boot({ rooms: [{ room_id: '!a', name: 'Galaxy', unread: 3, mention: true }, { room_id: '!b', name: 'Trade' }] });
  tb.renderNav();
  assert.equal(w.document.getElementById('menu-page-nav-items').textContent, 'SNC');
  S.tabs = ['!a', '!b']; S.roomId = '!b';
  tb.renderNav();
  const items = [...w.document.querySelectorAll('.chat-tab')];
  assert.equal(items.length, 2);
  assert.ok(items[0].querySelector('.chat-tab-dot.chat-mod-mention') && !/3/.test(items[0].textContent), 'a dot for a mention, no number');
  assert.ok(items[1].classList.contains('sui-mod-active'));
  assert.equal(tb.tabLabel('!a'), 'Galaxy'); assert.equal(tb.tabLabel('!nope'), '!nope');
  items[0].querySelector('.chat-tab-close').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  assert.equal(JSON.stringify(S.tabs), JSON.stringify(['!b']));
  assert.ok(!calls.some((c) => c[0] === 'openRoom' && c[1] === '!a'), 'the close did not also open the tab underneath');
  assert.equal(w.document.getElementById('chat-nav-comms').className, 'sui-mod-active');
}

console.log('chat-tabs: all checks passed');
