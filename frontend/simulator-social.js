/* Battle Simulator — the people around a battle.
 *
 * A battle can come from somewhere: a challenge card's Play in Comms (a room
 * and a thread, with a ladder), or a player's "Challenge to a battle" (a
 * person to send it to). Rust hands that over as a CONTEXT (simulator.rs,
 * `sim_take_context`); this file holds it and draws what it adds:
 *
 *   setup    the Challenge panel in the Round card's place — the battle's
 *            settings, who played and how, the thread and a reply box; both
 *            fleets locked, because results only compare on the same battle
 *   battle   the same thread beside the board
 *   debrief  your run posts ITSELF into the thread when it is your best (the
 *            rule the player chose); any other run stays here
 *
 * and, for any battle, "Post to…": a room or a DM from Comms. Nothing here
 * writes text into a room: Rust builds every message from the battle and
 * result codes (matrix_sim_post); the only words that leave are the ones
 * typed into the reply box, and those go into this battle's thread only.
 *
 *   window.SimSocial(api) → { take, adopt, isChallenge, locked, matches, addressed,
 *                             renderSetup, renderBattle, debrief, openPost, closePost, leave }
 */
(function () {
  'use strict';
  window.SimSocial = function (api) {
    var $ = api.$, el = api.el, icon = api.icon, button = api.button, cap = api.cap;
    var Code = window.StructsSimCode;

    function tauri() { return window.__TAURI__ && window.__TAURI__.core ? window.__TAURI__ : null; }
    function invoke(cmd, args) {
      var T = tauri();
      if (!T) return Promise.reject(new Error('Comms is not reachable from here'));
      return T.core.invoke(cmd, args || {});
    }
    function errText(e) { return String(e && e.message || e).replace(/^Error:\s*/, ''); }

    var ctx = null;          // { kind: 'challenge', guild_id, room_id, event_id, battle } | { kind: 'addressed', player_id, name, pfp_attrs }
    var view = null;         // matrix_sim_thread
    var viewError = null;
    var left = false;        // the fleets were opened for editing
    var lastAsk = 0;
    var post = null;         // the debrief's: { state: 'posting'|'posted'|'kept'|'undone'|'failed'|'edited'|'sending'|'sent', … }
    var lastRun = null;      // { config, result } of the debriefed run, for Try again / Send
    var drafts = {};         // reply box text, per panel

    // ── what the battle is ───────────────────────────────────────────────
    function codeOf(config) { try { return Code.encode(api.shareConfig(config)); } catch (e) { return null; } }
    function isChallenge() { return !!(ctx && ctx.kind === 'challenge'); }
    function isLive() { return !!(ctx && ctx.kind === 'live'); }
    function locked() { return (isChallenge() && !left) || isLive(); }
    function matches(config) { return isChallenge() && !!config && codeOf(config) === ctx.battle; }
    function addressed() { return ctx && ctx.kind === 'addressed' ? ctx : null; }
    function battleName() {
      var f = view && view.frame;
      if (f && f.name) return f.name;
      var c = ctx && ctx.battle && Code.decode(ctx.battle);
      return c && c.seed ? cap(c.seed) : 'Battle';
    }

    // ── the context ──────────────────────────────────────────────────────
    function take() {
      return invoke('sim_take_context').then(function (c) { if (c) adopt(c); }).catch(function () {});
    }
    function adopt(c) {
      closeMatch();
      stopDirect();
      if (c.kind === 'challenge') {
        var cfg = Code.decode(c.battle);
        if (!cfg) { api.message('That challenge does not hold a battle.'); return; }
        ctx = c; left = false; view = null; viewError = null; post = null;
        api.loadChallenge(cfg);
        refresh(true);
      } else if (c.kind === 'addressed') {
        ctx = c; left = false; view = null; post = null;
        api.renderAll();
      } else if (c.kind === 'live') {
        adoptLive(c);
      }
    }
    /* Leaving keeps the battle on the board; it just stops being the challenge. */
    function leave() {
      if (isLive() && live && live.phase !== 'over') sendFrame({ v: 1, kind: 'leave', forfeit: live.phase === 'battle' });
      if (isLive() && ctx.role === 'host' && live && live.phase === 'lobby') sendStatus({ state: 'cancelled' });
      closeMatch();
      stopDirect();
      ctx = null; view = null; left = false; post = null; live = null; api.renderAll();
    }
    /* Done with a live battle that had a room of its own: leave it and
     * forget it, so it never sits in anyone's room list. A battle in a DM
     * played where the conversation already was, and stays. Rust refuses any
     * room that is not a match room; a window that closes without saying
     * goodbye is swept at the next sign-in. */
    function closeMatch() {
      if (!isLive() || !ctx.match_room || ctx.match_room === ctx.room_id) return;
      invoke('matrix_sim_live_close', { guildId: ctx.guild_id, roomId: ctx.match_room }).catch(function () {});
    }
    function unlock() { left = true; api.renderAll(); }
    function relock() {
      var cfg = ctx && Code.decode(ctx.battle);
      if (!cfg) return;
      left = false;
      api.loadChallenge(cfg);
    }

    function refresh(force) {
      if (!isChallenge()) return;
      if (!force && Date.now() - lastAsk < 10000) return;
      lastAsk = Date.now();
      var asked = ctx;
      invoke('matrix_sim_thread', { guildId: ctx.guild_id, roomId: ctx.room_id, eventId: ctx.event_id })
        .then(function (v) { if (ctx !== asked) return; view = v; viewError = null; renderPanels(); })
        .catch(function (e) { if (ctx !== asked) return; viewError = errText(e); renderPanels(); });
    }
    // The thread moves while you play: a reply, somebody else's best.
    (function listen() {
      var T = tauri();
      if (!T || !T.event || !T.event.listen) return;
      T.event.listen('matrix::timeline', function (e) {
        var p = e && e.payload;
        if (isChallenge() && p && p.room_id === ctx.room_id) refresh(true);
        if (isLive() && p && p.room_id === ctx.match_room) onMatchChat(p.messages || []);
      });
      T.event.listen('matrix::sim', function (e) {
        var p = e && e.payload;
        if (isLive() && p && p.room_id === ctx.match_room) onFrame(p);
      });
    })();
    setInterval(function () { if (isChallenge() && !document.hidden) refresh(false); }, 30000);

    // ── live ─────────────────────────────────────────────────────────────
    // A head-to-head battle in a match room (simulator-live.js, matrix sim.rs
    // Live). The host's simulator runs it; the guest's and every watcher's
    // replay its ticks. ctx: { kind: 'live', role: 'host'|'guest'|'watch',
    // guild_id, room_id (where the invite is), invite_event, match_room,
    // battle, block_ms, host, host_name, host_pfp, me }.
    var live = null;   // { phase: 'lobby'|'battle'|'over', guest, ready, lastGuest, link, remote, chat, expectUser }
    var GUEST_GONE_MS = 30000, PING_MS = 10000;
    function liveCfg() { var c = Code.decode(ctx.battle); if (c) c.blockMs = ctx.block_ms || c.blockMs; return c; }
    /* A frame to the other side: over the direct line when it is open
     * (simulator-rtc.js), through the room when it is not — and through the
     * room as well when someone else needs it. Each frame carries this
     * window's session id and a sequence number, so one that arrives both
     * ways is used once. */
    var SID = Math.random().toString(36).slice(2, 10);
    var seqOut = 0;
    function sendFrame(frame) {
      if (!isLive()) return Promise.resolve();
      frame.sid = SID; frame.seq = ++seqOut;
      var direct = !!(live && live.rtc && live.rtc.send(frame));
      if (direct && !mustRelay(frame)) return Promise.resolve();
      return relay(frame);
    }
    function relay(frame) {
      return invoke('matrix_sim_live_send', { guildId: ctx.guild_id, roomId: ctx.match_room, frame: frame })
        .catch(function (e) { api.message('Not sent — ' + errText(e)); });
    }
    function mustRelay(f) {
      // A battle's end is said both ways: it must not ride a line that may be
      // the very thing that is failing.
      if (f.kind === 'end' || f.kind === 'leave') return true;
      // Watchers follow a room battle through the room; a DM has none.
      return ctx.role === 'host' && ctx.match_room !== ctx.room_id && (f.kind === 'tick' || f.kind === 'start');
    }
    /* The direct line: the host offers once its guest is known, the guest
     * answers. Until it opens, and if it never does, the room carries it all. */
    function peer() { return ctx.role === 'host' ? (live.guest && live.guest.user) : ctx.host; }
    function startDirect() {
      if (!window.SimRTC || ctx.role === 'watch' || (live.rtc && live.rtc.state() !== 'closed')) return;
      var asked = ctx;
      live.rtc = window.SimRTC({
        iceServers: function () { return invoke('matrix_sim_ice', { guildId: ctx.guild_id }).then(function (r) { return (r && r.servers) || []; }); },
        signal: function (f) { if (ctx === asked) relay(f); },
        onFrame: function (f) { if (ctx === asked && live) onFrame({ frame: f, sender: peer() }); },
        onState: function () { if (ctx === asked) api.renderAll(); },
      });
      if (!live.rtc.supported()) { live.rtc = null; return; }
      if (ctx.role === 'host') live.rtc.start();
    }
    function stopDirect() { if (live && live.rtc) { live.rtc.close(); live.rtc = null; } }
    function sendStatus(frame) {
      if (!isLive() || !ctx.invite_event) return;
      frame.v = 1; frame.kind = 'status';
      invoke('matrix_sim_live_status', { guildId: ctx.guild_id, roomId: ctx.room_id, inviteEvent: ctx.invite_event, frame: frame }).catch(function () {});
    }
    function person(user) {
      return invoke('matrix_person', { userId: user }).catch(function () { return { user_id: user, name: user }; });
    }
    function adoptLive(c) {
      var cfg = Code.decode(c.battle);
      if (!cfg) { api.message('That live battle does not hold a battle.'); return; }
      ctx = c; left = false; view = null; viewError = null; post = null;
      live = { phase: 'lobby', guest: null, ready: { host: false, guest: false }, lastGuest: Date.now(), chat: [], seen: {}, rtc: null, expectUser: c.expect ? c.expect.user_id : null };
      if (c.role === 'guest') live.guest = { user: c.me, name: 'You' };
      // The match's block time is the match's, not the layout's: it rides
      // in at the start (liveCfg) and never touches the setup board, whose
      // settings only know the battle code's own 2 s and 6 s.
      if (c.role === 'watch') {
        live.phase = 'battle';
        api.startLive(liveCfg(), liveOpts('watch'));
      } else {
        // A guest flies the other fleet: drawn on the left, as in the battle.
        api.loadChallenge(c.role === 'guest' ? api.swapped(cfg) : cfg);
      }
      if (c.role === 'guest') { startDirect(); sendFrame({ v: 1, kind: 'hello' }); }
      loadMatchChat();
      api.renderAll();
    }
    /* Host: open the battle to a player (their DM) or to a room (anyone there). */
    function openLive(target) {
      var code = codeOf(api.currentConfig());
      if (!code) { api.message('This battle cannot be played live.'); return; }
      api.message('Opening a live battle…');
      invoke('matrix_sim_live_open', { guildId: target.guildId || null, roomId: target.roomId || null, toPlayer: target.toPlayer || null, battle: code, blockMs: 4000 })
        .then(function (r) {
          adopt({ kind: 'live', role: 'host', guild_id: r.guild_id, room_id: r.room_id, invite_event: r.invite_event, match_room: r.match_room,
            battle: code, block_ms: r.block_ms, host: r.me, me: r.me, host_name: 'You', expect: r.guest || null, target: target });
          api.message(r.guest ? 'Invited ' + r.guest.name + '.' : 'Posted. The first to accept plays.');
        })
        .catch(function (e) { api.message('Not opened — ' + errText(e)); });
    }
    function liveOpts(role) {
      return {
        role: role,
        host: { name: ctx.role === 'host' ? 'You' : ctx.host_name, pfp: ctx.host_pfp || null },
        guest: live.guest ? { name: live.guest.name, pfp: live.guest.pfp_attrs || null } : { name: 'Guest', pfp: null },
        send: sendFrame,
        attach: function (h) { live.link = window.SimLive.HostLink(h, sendFrame); },
        remote: function (r) { live.remote = r; },
      };
    }
    function opponentName() {
      if (!isLive()) return null;
      if (ctx.role === 'host') return live.guest ? live.guest.name : 'Guest';
      if (ctx.role === 'guest') return ctx.host_name;
      return null;
    }
    /* The header's button in a live lobby: Ready, and back. */
    function onStart() {
      if (!isLive()) return false;
      if (live.phase !== 'lobby' || ctx.role === 'watch') return true;
      var mine = ctx.role === 'host' ? 'host' : 'guest';
      live.ready[mine] = !live.ready[mine];
      sendFrame({ v: 1, kind: 'ready', ready: live.ready[mine] });
      maybeBegin();
      api.renderAll();
      return true;
    }
    function maybeBegin() {
      if (ctx.role !== 'host' || live.phase !== 'lobby' || !live.guest || !live.ready.host || !live.ready.guest) return;
      live.phase = 'battle';
      sendFrame({ v: 1, kind: 'start', battle: ctx.battle, block_ms: ctx.block_ms });
      sendStatus({ state: 'live', guest: live.guest.user });
      api.startLive(liveCfg(), liveOpts('host'));
    }
    function onFrame(p) {
      var f = p.frame || {}, from = p.sender;
      if (!from || from === ctx.me) return;   // our own, echoed back by sync
      // The same frame by both paths: the first one counts. Only an exact
      // repeat is dropped — while the line opens, a room frame can arrive
      // after a newer direct one and still be news (a move, a ready). A tick
      // older than one already shown is the exception: replaying it would
      // wind the board back.
      if (typeof f.sid === 'string' && typeof f.seq === 'number') {
        var key = from + ' ' + f.sid;
        var seen = live.seen[key] || (live.seen[key] = { ids: {}, tick: 0 });
        if (seen.ids[f.seq]) return;
        seen.ids[f.seq] = 1;
        if (f.kind === 'tick') { if (f.seq < seen.tick) return; seen.tick = f.seq; }
      }
      // The direct line's handshake, from the one person it is with.
      if (f.kind === 'rtc') { if (live.rtc && from === peer()) live.rtc.signal(f); return; }
      var now = Date.now();
      if (ctx.role === 'host') {
        if (f.kind === 'hello') {
          if (live.phase !== 'lobby' || (live.guest && live.guest.user !== from) || (live.expectUser && from !== live.expectUser)) return;
          live.guest = { user: from, name: '…' };
          live.lastGuest = now;
          person(from).then(function (pp) {
            if (!live || !live.guest || live.guest.user !== from) return;
            live.guest.name = pp.name || from; live.guest.pfp_attrs = pp.pfp_attrs || null; live.guest.player_id = pp.player_id || null;
            api.renderAll();
          });
          sendStatus({ state: 'lobby', guest: from });
          // A guest that says hello again is a fresh window: a fresh line.
          stopDirect();
          startDirect();
          // Late joiner: tell them where we stand.
          if (live.ready.host) sendFrame({ v: 1, kind: 'ready', ready: true });
          api.renderAll();
          return;
        }
        if (!live.guest || from !== live.guest.user) return;   // a watcher has no say
        live.lastGuest = now;
        if (f.kind === 'ready') { live.ready.guest = f.ready !== false; maybeBegin(); api.renderAll(); }
        else if (f.kind === 'move' && live.link) live.link.move(f);
        else if (f.kind === 'leave') guestLeft(f);
        return;
      }
      if (from !== ctx.host) return;   // only the host runs the battle
      if (f.kind === 'ready') { live.ready.host = f.ready !== false; api.renderAll(); }
      else if (f.kind === 'start' && ctx.role === 'guest' && live.phase === 'lobby') { live.phase = 'battle'; api.startLive(liveCfg(), liveOpts('guest')); }
      else if (f.kind === 'tick') {
        if (!live.remote && ctx.role === 'guest' && live.phase === 'lobby') { live.phase = 'battle'; api.startLive(liveCfg(), liveOpts('guest')); }
        if (live.remote) live.remote.tick(f);
      }
      else if (f.kind === 'end') { if (live.remote) live.remote.end(f); live.phase = 'over'; api.renderAll(); }
      else if (f.kind === 'leave') {
        if (live.phase === 'lobby') { api.message(ctx.host_name + ' left.'); live.phase = 'over'; api.renderAll(); }
        else if (live.remote && !live.remote.finished) live.remote.end({ winner: ctx.role === 'guest' ? 'guest' : 'draw', gone: true });
      }
    }
    function guestLeft(f) {
      if (live.phase === 'lobby') {
        live.guest = null; live.ready.guest = false;
        stopDirect();
        sendStatus({ state: 'lobby' });
        api.renderAll();
        return;
      }
      if (live.phase === 'battle') api.concede(!!f.gone);
    }
    // The guest says it is still there; the host notices when it is not.
    setInterval(function () {
      if (!isLive() || !live || live.phase !== 'battle') return;
      if (ctx.role === 'guest') sendFrame({ v: 1, kind: 'ping' });
      if (ctx.role === 'host' && Date.now() - live.lastGuest > GUEST_GONE_MS) guestLeft({ gone: true });
    }, PING_MS / 2);
    /* How the other side is doing, for the battle bar. */
    function connection() {
      if (!isLive() || !live || live.phase !== 'battle') return null;
      // Over is over: a host that stopped ticking after the end is not lagging.
      if (live.remote && live.remote.finished) return null;
      var blockMs = ctx.block_ms || 4000;
      if (ctx.role === 'host') {
        var quiet = Date.now() - live.lastGuest;
        return quiet > GUEST_GONE_MS * 0.5 ? { state: 'bad', text: 'Gone · forfeits in ' + Math.max(0, Math.ceil((GUEST_GONE_MS - quiet) / 1000)) + ' s' }
          : quiet > PING_MS * 1.5 ? { state: 'warn', text: 'Lagging' } : { state: 'ok', text: linkText() };
      }
      var lag = live.remote ? live.remote.lag(blockMs) : 0;
      return lag >= 5 ? { state: 'bad', text: 'Host not answering' } : lag >= 2 ? { state: 'warn', text: 'Lagging · ' + lag + ' blocks' } : { state: 'ok', text: linkText() };
    }
    function linkText() { return live.rtc && live.rtc.state() === 'open' ? 'Direct' : 'Connected';
    }
    // The match room's own talk. Players hear each other; a watcher's lines
    // reach the players after the battle, so nobody is coached mid-fight.
    function loadMatchChat() {
      if (!isLive()) return;
      var asked = ctx;
      invoke('matrix_timeline', { guildId: ctx.guild_id, roomId: ctx.match_room, limit: 40 })
        .then(function (t) { if (ctx !== asked) return; live.chat = []; onMatchChat((t && t.messages) || []); })
        .catch(function () {});
    }
    function onMatchChat(list) {
      list.forEach(function (m) {
        if (!m || m.sim || (m.kind !== 'text' && m.kind !== 'emote')) return;
        if (live.chat.some(function (x) { return x.event_id === m.event_id; })) return;
        live.chat.push({ event_id: m.event_id, sender: m.sender, name: m.sender_name, body: m.body, ts: m.ts, self: !!m.self });
      });
      live.chat = live.chat.slice(-60);
      renderPanels();
    }
    function players() { return [ctx.host, live.guest && live.guest.user].filter(Boolean); }
    function audible(m) {
      if (ctx.role === 'watch' || live.phase !== 'battle') return true;
      return players().indexOf(m.sender) !== -1 || m.self;
    }

    // ── the panel ────────────────────────────────────────────────────────
    function portrait(attrs, cls) {
      var frame = el('span', null, 'sim-pfp' + (cls ? ' ' + cls : ''));
      if (window.StructsPfp) window.StructsPfp.fillPortrait(frame, attrs || null);
      return frame;
    }
    function me() { return view && view.me; }
    function myEntry() { var m = me(); return ((view && view.ladder) || []).filter(function (e) { return e.sender === m; })[0] || null; }

    function ladderNode(max) {
      var lad = (view && view.ladder) || [];
      var box = el('div', null, 'sim-ladder');
      if (!lad.length) { box.appendChild(el('div', view ? 'Nobody has played it yet' : 'Reading the ladder…', 'sim-ladder-empty sui-text-hint')); return box; }
      lad.slice(0, max).forEach(function (e) {
        var o = e.outcome || {};
        var row = el('div', null, 'sim-run' + (e.sender === me() ? ' sim-run-me' : '') + (o.current ? '' : ' sim-run-old'));
        row.appendChild(el('span', String(e.rank), 'sui-text-label sui-text-hint'));
        row.appendChild(portrait(e.pfp_attrs));
        row.appendChild(el('span', e.sender === me() ? 'You' : String(e.name || ''), 'sui-text-label sim-run-name'));
        // The time in the verdict's colour: won teal, drawn amber, lost red.
        row.appendChild(el('span', String(o.time || ''),
          'sui-text-label sim-run-time ' + (o.winner === 'player' ? 'sim-you' : o.winner === 'draw' ? 'sim-warn' : 'sim-cpu')));
        row.title = [e.name, o.verdict, o.time, 'lost ' + o.lost + ' of ' + o.fielded, o.blocks + ' blocks'].join(' · ') + (o.current ? '' : ' · older rules');
        box.appendChild(row);
      });
      if (lad.length > max) box.appendChild(el('div', '+' + (lad.length - max) + ' more', 'sim-ladder-empty sui-text-hint'));
      return box;
    }

    /* The talk, drawn as every window draws a conversation: chatrow.js rows
     * (chat-rows.css), the same component the Comms window and the Map
     * Viewer's rail use. Read-only here, as on the rail. */
    function myId() { return (ctx && ctx.me) || (view && view.me) || null; }
    function talkNode(title, count, list) {
      var box = el('div', null, 'sim-thread');
      var head = el('div', null, 'sim-thread-h');
      head.appendChild(el('span', title, 'sui-text-label sui-text-hint'));
      if (count != null) head.appendChild(el('span', String(count), 'sui-text-label sui-text-hint'));
      box.appendChild(head);
      var R = window.StructsChatRow;
      // `sui-text-tiny`, as on the Map Viewer's rail: the rows inherit it.
      var rows = el('div', null, 'sim-talk sui-text-tiny');
      var prev = null;
      list.forEach(function (r) {
        var m = { kind: 'text', event_id: r.event_id, sender: r.sender, sender_name: r.name, sender_tag: r.tag || null, player_id: r.player_id || null,
          body: String(r.body || ''), ts: r.ts, self: !!r.self || (!!r.sender && r.sender === myId()) };
        var node = R.render(m, prev, {});
        var b = R.body(m, {});
        if (b) node.appendChild(b);
        rows.appendChild(node);
        prev = m;
      });
      box.appendChild(rows);
      return box;
    }
    function threadNode(max) {
      return talkNode('Thread', (view && view.reply_count) || 0, ((view && view.replies) || []).slice(-max));
    }

    /* The composer is the game's own — StructsChatRow.composer(), the panel
     * Comms and the Map Viewer's rail speak from: the message on an inset
     * screen, the send as an action-bar button. Built
     * once per panel and kept across repaints, so a ladder that moves
     * mid-sentence does not take the sentence with it. */
    function composer(key) {
      var c = window.StructsChatRow.composer({ placeholder: 'Reply', maxLength: 2000 });
      var box = el('div', null, 'sim-reply sui-text-tiny');
      box.appendChild(c.node);
      var input = c.input;
      input.setAttribute('aria-label', 'Reply in the thread');
      input.value = drafts[key] || '';
      input.addEventListener('input', function () { drafts[key] = input.value; });
      c.send.setAttribute('aria-label', 'Send'); c.send.title = 'Send';
      function sendIt() {
        var text = input.value.trim();
        if (!text || input.disabled || !(isChallenge() || isLive())) return;
        input.disabled = true;
        (isLive() ? invoke('matrix_send', { guildId: ctx.guild_id, roomId: ctx.match_room, body: text })
          : invoke('matrix_sim_reply', { guildId: ctx.guild_id, roomId: ctx.room_id, eventId: ctx.event_id, body: text }))
          .then(function () { input.value = ''; drafts[key] = ''; refresh(true); })
          .catch(function (e) { api.message('Not sent — ' + errText(e)); })
          .then(function () { input.disabled = false; input.focus(); });
      }
      c.send.addEventListener('click', sendIt);
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendIt(); }
      });
      return box;
    }

    /* The battle's name, in the display face when it fits the column and a
     * size down when it does not: a name is never cut to "SPEARPOI…". */
    function titleNode() {
      var t = el('span', battleName(), 'sui-text-display sim-title');
      t.title = battleName();
      requestAnimationFrame(function () {
        if (t.isConnected && t.scrollWidth > t.clientWidth) t.classList.replace('sui-text-display', 'sui-text-label');
      });
      return t;
    }

    function liveBody(body, opts) {
      var top = el('div', null, 'sim-challenge-top');
      top.appendChild(titleNode());
      var c = Code.decode(ctx.battle);
      if (c && !opts.compact) {
        var chips = el('div', null, 'sim-chips');
        [(ctx.block_ms || 4000) / 1000 + ' s', 'Charge ' + c.charge.player + ' · ' + c.charge.computer, 'Fleets fixed'].forEach(function (t) {
          chips.appendChild(el('span', t, 'sim-chip sui-text-label'));
        });
        top.appendChild(chips);
      }
      body.appendChild(top);
      var who = el('div', null, 'sim-ladder');
      function seat(name, pfp, mine, state, tone) {
        var row = el('div', null, 'sim-run' + (mine ? ' sim-run-me' : ''));
        row.appendChild(el('span', '', 'sui-text-label'));
        row.appendChild(portrait(pfp));
        row.appendChild(el('span', name, 'sui-text-label sim-run-name ' + (mine ? 'sim-you' : 'sim-cpu')));
        row.appendChild(el('span', state, 'sui-text-label ' + tone));
        who.appendChild(row);
      }
      var ready = function (on) { return live.phase === 'lobby' ? (on ? 'Ready' : '') : live.phase === 'over' ? '' : 'Playing'; };
      var hostMine = ctx.role === 'host';
      seat(hostMine ? 'You' : ctx.host_name, ctx.host_pfp, hostMine, ready(live.ready.host), live.ready.host || live.phase !== 'lobby' ? 'sim-you' : 'sui-text-hint');
      if (live.guest) seat(ctx.role === 'guest' ? 'You' : live.guest.name, live.guest.pfp_attrs, ctx.role === 'guest', ready(live.ready.guest), live.ready.guest || live.phase !== 'lobby' ? 'sim-you' : 'sui-text-hint');
      else who.appendChild(el('div', ctx.expect ? 'Waiting for ' + ctx.expect.name : 'Waiting for someone to accept', 'sim-ladder-empty sui-text-hint'));
      body.appendChild(who);
      var talk = talkNode(ctx.role === 'watch' ? 'Watchers and players' : 'Match chat', null, live.chat.filter(audible).slice(opts.compact ? -4 : -8));
      body.appendChild(talk);
    }

    function panel(box, key, opts) {
      if (!box) return;
      var show = isLive() || (isChallenge() && (opts.always || !left));
      box.classList.toggle('hidden', !show);
      if (!show) return;
      if (!box.dataset.built) {
        box.replaceChildren();
        var h = el('div', null, 'sim-card-h');
        h.appendChild(el('span', 'Challenge', 'sui-text-label sim-warn sim-panel-title'));
        var x = button(null, 'sui-screen-btn sim-square', function () { leave(); });
        x.setAttribute('aria-label', 'Leave'); x.title = 'Leave';
        x.appendChild(icon('close', 'sm'));
        h.appendChild(x);
        box.appendChild(h);
        box.appendChild(el('div', null, 'sim-challenge-b'));
        box.appendChild(composer(key));
        box.dataset.built = '1';
      }
      var body = box.querySelector('.sim-challenge-b');
      body.replaceChildren();
      box.querySelector('.sim-panel-title').textContent = isLive() ? (ctx.role === 'watch' ? 'Watching' : 'Live battle') : 'Challenge';
      var reply = box.querySelector('.sim-reply');
      if (reply) {
        reply.querySelector('textarea').placeholder = isLive() ? 'Message' : 'Reply';
      }
      if (isLive()) { liveBody(body, opts); return; }
      var top = el('div', null, 'sim-challenge-top');
      top.appendChild(titleNode());
      if (view && view.author) {
        var by = el('span', null, 'sim-by');
        by.appendChild(portrait(view.author.pfp_attrs));
        by.appendChild(el('span', String(view.author.name || ''), 'sui-text-label sim-them'));
        if (view.room_name) by.appendChild(el('span', String(view.room_name), 'sui-text-hint'));
        top.appendChild(by);
      }
      var c = ctx && Code.decode(ctx.battle);
      if (c && !opts.compact) {
        var chips = el('div', null, 'sim-chips');
        [cap(c.difficulty), (c.blockMs / 1000) + ' s', 'Charge ' + c.charge.player + ' · ' + c.charge.computer].forEach(function (t) {
          chips.appendChild(el('span', t, 'sim-chip sui-text-label'));
        });
        top.appendChild(chips);
      }
      body.appendChild(top);
      if (viewError) body.appendChild(el('div', viewError, 'sim-ladder-empty sui-text-hint'));
      body.appendChild(ladderNode(opts.compact ? 3 : 6));
      body.appendChild(threadNode(opts.compact ? 3 : 6));
    }

    function renderPanels() {
      panel($('challenge'), 'setup', {});
      var onBattle = document.body.dataset.screen === 'battle';
      panel($('battle-thread'), 'battle', { compact: true, always: false });
      if (!onBattle || !(isLive() || matches(api.initial()))) $('battle-thread').classList.add('hidden');
      panel($('db-challenge'), 'debrief', { always: true });
      if (document.body.dataset.screen !== 'debrief' || !(isChallenge() || isLive())) $('db-challenge').classList.add('hidden');
      document.body.classList.toggle('sim-live', isLive());
      renderStart();
      renderPost();
    }

    // ── setup ────────────────────────────────────────────────────────────
    function renderSetup() {
      var lockedNow = locked();
      $('round').classList.toggle('hidden', lockedNow);
      $('locked-chip').classList.toggle('hidden', !lockedNow);
      $('locked-chip').textContent = battleName() + ' fleets';
      $('unlock').classList.toggle('hidden', !lockedNow || isLive());
      $('relock').classList.toggle('hidden', !(isChallenge() && left));
      $('mirror').classList.toggle('hidden', lockedNow);
      $('swap').classList.toggle('hidden', lockedNow);
      $('fleet-head').classList.toggle('sim-head-stack', lockedNow || (isChallenge() && left));
      // The other side of the board is a person in a live battle.
      var cpuName = document.querySelector('#fleet-head .sim-cpu');
      if (cpuName) cpuName.textContent = opponentName() || 'Computer';
      var to = addressed();
      $('addressed').classList.toggle('hidden', !to);
      $('send-to').classList.toggle('hidden', !to);
      $('live-to').classList.toggle('hidden', !to);
      $('live-room').classList.toggle('hidden', !isChallenge() || left);
      if (to) $('live-to').querySelector('span').textContent = 'Play ' + to.name + ' live';
      if (to) {
        $('addressed-name').textContent = 'For ' + to.name;
        var pf = $('addressed-pfp'); pf.replaceChildren();
        if (window.StructsPfp) window.StructsPfp.fillPortrait(pf, to.pfp_attrs || null);
        $('send-to').querySelector('span').textContent = 'Send to ' + to.name;
      }
      renderPanels();
    }

    /* The header's button: Start battle, or in a live lobby, Ready. */
    function renderStart() {
      var b = $('start');
      var label = b.querySelector('span') || b.insertBefore(document.createElement('span'), b.firstChild);
      if (b.firstChild && b.firstChild.nodeType === 3) b.removeChild(b.firstChild);
      if (!isLive()) { label.textContent = 'Start battle'; b.classList.remove('sim-on'); return; }
      var mine = ctx.role === 'host' ? live.ready.host : live.ready.guest;
      label.textContent = live.phase !== 'lobby' ? 'Started' : mine ? 'Ready · waiting' : 'Ready';
      b.classList.toggle('sim-on', !!mine);
      b.disabled = live.phase !== 'lobby' || ctx.role === 'watch';
    }

    function renderBattle() {
      var on = isLive() || matches(api.initial());
      $('battle-thread').classList.toggle('hidden', !on);
      if (on) panel($('battle-thread'), 'battle', { compact: true });
    }

    // ── debrief ──────────────────────────────────────────────────────────
    /* After a run: into the thread if it is your best on this challenge, to
     * the person if the battle is addressed, otherwise nothing — Share is
     * there for that. */
    function debrief(config, result) {
      lastRun = { config: config, result: result };
      post = null;
      if (isLive()) {
        live.phase = 'over';
        if (ctx.role === 'host') {
          var f = api.summary().finished || {};
          var winner = f.winner === 'you' ? 'host' : f.winner === 'cpu' ? 'guest' : 'draw';
          var end = { v: 1, kind: 'end', winner: winner, forfeit: !!f.forfeit, stalemate: f.stalemate || null, gone: !!f.gone, summary: api.summary() };
          if (live.link) live.link.after(end); else sendFrame(end);
          sendStatus({ state: 'ended', guest: live.guest && live.guest.user, winner: winner === 'host' ? ctx.host : winner === 'guest' ? live.guest && live.guest.user : null });
        }
        post = { state: 'live' };
        renderPanels();
        return;
      }
      if (matches(config)) {
        post = { state: 'posting' };
        renderPost();
        invoke('matrix_sim_post', { guildId: ctx.guild_id, roomId: ctx.room_id, battle: ctx.battle, result: result, thread: ctx.event_id })
          .then(function (r) {
            post = r && r.posted ? { state: 'posted', event_id: r.event_id, top: r.top, beat: r.beat } : { state: 'kept' };
            refresh(true);
            renderPost();
          })
          .catch(function (e) { post = { state: 'failed', error: errText(e) }; renderPost(); });
      } else if (isChallenge()) {
        post = { state: 'edited' };
      } else if (addressed()) {
        post = { state: 'send' };
      }
      renderPanels();
    }

    function strip(cls, glyph, title, sub, buttons) {
      var box = $('db-post');
      box.className = 'sim-post ' + cls;
      box.replaceChildren();
      if (glyph) box.appendChild(icon(glyph));
      var text = el('span', null, 'sim-post-text');
      text.appendChild(el('span', title, 'sui-text-label'));
      if (sub) text.appendChild(el('span', sub, 'sui-text-hint'));
      box.appendChild(text);
      (buttons || []).forEach(function (b) { box.appendChild(b); });
    }

    function renderPost() {
      var box = $('db-post');
      if (!post || document.body.dataset.screen !== 'debrief') { box.className = 'sim-post hidden'; return; }
      var name = battleName();
      var mine = myEntry();
      var lad = (view && view.ladder) || [];
      var where = view && view.room_name ? view.room_name + ' · thread' : 'the thread';
      if (post.state === 'live') {
        var fin = api.summary().finished || {};
        var other = opponentName() || (ctx.role === 'watch' ? 'the guest' : '');
        if (ctx.role === 'watch') {
          return strip('sim-post-quiet', 'detected', fin.winner === 'draw' ? 'A draw' : (fin.winner === 'you' ? ctx.host_name : (live.guest && live.guest.name) || 'The guest') + ' won', 'live · ' + name);
        }
        var title = fin.winner === 'you' ? 'You beat ' + other : fin.winner === 'cpu' ? other + ' beat you' : 'A draw with ' + other;
        var why = fin.gone ? (fin.winner === 'you' ? other + ' left' : 'the connection dropped') : fin.forfeit ? 'forfeit' : 'live';
        return strip(fin.winner === 'you' ? 'sim-post-good' : 'sim-post-quiet', fin.winner === 'you' ? 'success' : 'info', title, why + ' · ' + name);
      }
      if (post.state === 'posting') return strip('sim-post-quiet', 'in-progress', 'Posting your best…', where);
      if (post.state === 'posted') {
        var undo = button('Undo', 'sui-screen-btn', function () {
          undo.disabled = true;
          invoke('matrix_redact', { guildId: ctx.guild_id, roomId: ctx.room_id, eventId: post.event_id })
            .then(function () { post = { state: 'undone' }; refresh(true); renderPost(); })
            .catch(function (e) { undo.disabled = false; api.message('Not undone — ' + errText(e)); });
        });
        var place = mine ? ordinal(mine.rank) + ' of ' + lad.length + ' on ' + name : 'on ' + name;
        return strip('sim-post-good', 'success', post.top ? 'New best · posted' : 'Your best · posted', place, [el('span', where, 'sui-text-hint sim-post-where'), undo]);
      }
      if (post.state === 'kept') {
        return strip('sim-post-quiet', 'info', mine ? 'Your best stays ' + mine.outcome.time : 'Not posted',
          mine ? ordinal(mine.rank) + ' of ' + lad.length + ' on ' + name + ' · this run stays here' : 'this run stays here');
      }
      if (post.state === 'undone') return strip('sim-post-quiet', 'info', 'Taken back', 'this run stays here');
      if (post.state === 'edited') return strip('sim-post-quiet', 'info', 'Your own battle', 'edited fleets · not on the ' + name + ' ladder');
      if (post.state === 'failed') {
        return strip('sim-post-bad', 'alert', 'Not posted', post.error, [button('Try again', 'sui-screen-btn', function () {
          if (lastRun) debrief(lastRun.config, lastRun.result);
        })]);
      }
      var to = addressed();
      if (to && (post.state === 'send' || post.state === 'sending')) {
        var go = button('Send to ' + to.name, 'sui-screen-btn sui-mod-primary', function () {
          post = { state: 'sending' }; renderPost();
          invoke('matrix_sim_post', { toPlayer: to.player_id, battle: codeOf(lastRun.config), result: lastRun.result })
            .then(function () { post = { state: 'sent' }; renderPost(); })
          .catch(function (e) { post = { state: 'send' }; renderPost(); api.message('Not sent — ' + errText(e)); });
        });
        if (post.state === 'sending') go.disabled = true;
        return strip('sim-post-quiet', 'outgoing', 'For ' + to.name, 'your run is the time to beat', [go]);
      }
      if (to && post.state === 'sent') return strip('sim-post-good', 'success', 'Sent to ' + to.name, 'in your DM');
      box.className = 'sim-post hidden';
    }
    function ordinal(n) {
      n = Number(n) || 0;
      var s = n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th';
      return n + s;
    }

    // ── Send to (setup) ──────────────────────────────────────────────────
    function sendNow() {
      var to = addressed();
      if (!to) return;
      var code = codeOf(api.currentConfig());
      if (!code) { api.message('This battle cannot be shared.'); return; }
      $('send-to').disabled = true;
      invoke('matrix_sim_post', { toPlayer: to.player_id, battle: code })
        .then(function () { api.message('Sent to ' + to.name + '.'); })
        .catch(function (e) { api.message('Not sent — ' + errText(e)); })
        .then(function () { $('send-to').disabled = false; });
    }

    // ── Post to… ─────────────────────────────────────────────────────────
    var postTo = { rooms: [], guild: null, pick: null, config: null, result: null, line: '' };
    function openPost(config, result, line) {
      postTo.config = config; postTo.result = result || null; postTo.line = line || '';
      var what = $('post-what'); what.replaceChildren();
      var c = config;
      what.appendChild(el('span', line || ((c.seed ? cap(c.seed) : 'Battle') + ' · ' + cap(c.difficulty)), 'sui-text-label ' + (result ? 'sim-you' : '')));
      $('post-title').textContent = result ? 'Share result' : 'Share battle';
      $('post-find').value = '';
      $('post-dialog').classList.remove('hidden');
      $('post-rooms').replaceChildren(el('div', 'Reading your rooms…', 'sui-text-hint'));
      $('post-send').disabled = true;
      invoke('matrix_sim_rooms').then(function (r) {
        postTo.rooms = (r && r.rooms) || []; postTo.guild = r && r.guild_id;
        var to = addressed();
        postTo.pick = null;
        if (to) postTo.pick = (postTo.rooms.filter(function (x) { return x.player_id === to.player_id; })[0] || {}).room_id || null;
        // Nothing is picked for you: one click must never post to whoever
        // happens to be first in the list.
        roomList();
      }).catch(function (e) {
        $('post-rooms').replaceChildren(el('div', errText(e), 'sui-text-hint'));
      });
      $('post-find').focus();
    }
    function closePost() { $('post-dialog').classList.add('hidden'); }
    function roomList() {
      var q = $('post-find').value.trim().toLowerCase();
      var list = postTo.rooms.filter(function (r) { return !q || String(r.name || '').toLowerCase().indexOf(q) !== -1; });
      var box = $('post-rooms'); box.replaceChildren();
      if (!list.length) box.appendChild(el('div', postTo.rooms.length ? 'No room by that name' : 'No rooms yet', 'sui-text-hint'));
      list.slice(0, 8).forEach(function (r) {
        var b = button(null, 'sim-opt sim-room', function () { postTo.pick = r.room_id; roomList(); });
        b.setAttribute('role', 'radio');
        b.setAttribute('aria-checked', String(postTo.pick === r.room_id));
        if (r.player_id) b.appendChild(portrait(r.pfp_attrs));
        else b.appendChild(icon(String(r.icon || 'icon-guild-directory').replace(/^icon-/, ''), 'md'));
        b.appendChild(el('span', String(r.name || r.room_id), 'sui-text-label sim-room-name'));
        b.appendChild(el('span', r.player_id ? 'direct' : r.section === 'direct' ? 'direct' : 'channel', 'sui-text-hint'));
        box.appendChild(b);
      });
      var picked = postTo.rooms.filter(function (r) { return r.room_id === postTo.pick; })[0];
      $('post-send').disabled = !picked;
      $('post-send').querySelector('span').textContent = picked ? 'Post to ' + picked.name : 'Post';
    }
    function sendPost() {
      var code = codeOf(postTo.config);
      if (!code || !postTo.pick) return;
      $('post-send').disabled = true;
      invoke('matrix_sim_post', { guildId: postTo.guild, roomId: postTo.pick, battle: code, result: postTo.result })
        .then(function () {
          var picked = postTo.rooms.filter(function (r) { return r.room_id === postTo.pick; })[0];
          closePost();
          api.message('Posted to ' + (picked ? picked.name : 'the room') + '.');
        })
        .catch(function (e) { $('post-send').disabled = false; api.message('Not posted — ' + errText(e)); });
    }
    $('post-find').addEventListener('input', roomList);
    $('post-close').addEventListener('click', closePost);
    $('post-send').addEventListener('click', sendPost);
    $('post-copy').addEventListener('click', function () { closePost(); api.copyFor(postTo.config, postTo.result, postTo.line); });
    $('send-to').addEventListener('click', sendNow);
    $('addressed-clear').addEventListener('click', leave);
    $('live-to').addEventListener('click', function () { var to = addressed(); if (to) openLive({ toPlayer: to.player_id }); });
    $('live-room').addEventListener('click', function () { if (isChallenge()) openLive({ guildId: ctx.guild_id, roomId: ctx.room_id }); });
    $('unlock').addEventListener('click', unlock);
    $('relock').addEventListener('click', relock);

    return {
      take: take, adopt: adopt, isChallenge: isChallenge, locked: locked, matches: matches, addressed: addressed,
      renderSetup: renderSetup, renderBattle: renderBattle, renderPanels: renderPanels, debrief: debrief,
      openPost: openPost, closePost: closePost, leave: leave, battleName: battleName,
      context: function () { return ctx; }, view: function () { return view; },
      isLive: isLive, liveRole: function () { return isLive() ? ctx.role : null; }, onStart: onStart, openLive: openLive,
      opponentName: opponentName, connection: connection, swapped: function (c) { return api.swapped(c); },
      rematch: function () {
        if (!isLive() || ctx.role !== 'host') return false;
        var g = live.guest, t = ctx.target || {};
        openLive(g && g.player_id ? { toPlayer: g.player_id } : t);
        return true;
      },
    };
  };
})();
