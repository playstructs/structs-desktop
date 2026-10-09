/* Battle Simulator — the people around a battle.
 *
 * A battle can come from somewhere: a challenge card's Play in Comms (a room
 * and a thread, with a ladder), a player's "Challenge to a battle" (a person
 * to send it to), or a live invite. Rust hands that over as a CONTEXT
 * (simulator.rs, `sim_take_context`); this file holds it and draws what it
 * adds, in COMMAND DECK parts (simdeck.js):
 *
 *   setup    the Challenge panel in the Mission panel's place — the battle's
 *            settings as pills, who played and how, the last of the thread;
 *            both fleets fixed, because results only compare on the same
 *            battle. Live: the lobby — the two seats and the match's talk.
 *            The top bar's mode badge, the addressed strip and Send to.
 *   battle   the talk is the Map Viewer's own rail beside the board (`talk`)
 *   debrief  your run posts ITSELF into the thread when it is your best (the
 *            rule the player chose), said in the alert band; any other run
 *            stays here. Live: the head-to-head band.
 *
 * and, for any battle, "Post to…": a room or a DM from Comms. Nothing here
 * writes text into a room: Rust builds every message from the battle and
 * result codes (matrix_sim_post); the only words that leave are the ones a
 * player types to the match (the lobby's composer, the rail).
 *
 *   window.SimSocial(api) → { take, adopt, isChallenge, locked, matches, addressed,
 *                             renderSetup, renderBattle, debrief, openPost, closePost, leave }
 */
(function () {
  'use strict';
  window.SimSocial = function (api) {
    var $ = api.$, cap = api.cap;
    var Code = window.StructsSimCode, D = window.SimDeck;
    var de = D.el;   // (tag, cls, text)

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
      // After the battle too: the other side's debrief stops saying Connected.
      if (isLive() && live) sendFrame({ v: 1, kind: 'leave', forfeit: live.phase === 'battle' });
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
        .then(function (v) { if (ctx !== asked) return; view = v; viewError = null; renderPanels(); api.renderReady(); })
        .catch(function (e) { if (ctx !== asked) return; viewError = errText(e); renderPanels(); });
    }
    // The thread moves while you play: a reply, somebody else's best.
    (function listen() {
      var T = tauri();
      if (!T || !T.event || !T.event.listen) return;
      T.event.listen('matrix::timeline', function (e) {
        var p = e && e.payload;
        if (isChallenge() && p && p.room_id === ctx.room_id) { refresh(true); api.talkChanged(threadRoomId(), p.messages); }
        if (isLive() && p && p.room_id === ctx.match_room) { onMatchChat(p.messages || []); api.talkChanged(ctx.match_room, p.messages); }
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
      if (chat) chat.input.value = '';
      live = { phase: 'lobby', guest: null, ready: { host: false, guest: false }, lastGuest: Date.now(), chat: [], seen: {}, rtc: null, expectUser: c.expect ? c.expect.user_id : null };
      if (c.role === 'guest') live.guest = { user: c.me, name: 'You' };
      // Your own seat wears your own face, as the other one does.
      if (c.role !== 'watch' && c.me) {
        var mine = live;
        person(c.me).then(function (pp) {
          if (live !== mine || !pp || !pp.player_id) return;
          live.me = { player_id: pp.player_id, pfp_attrs: pp.pfp_attrs || null };
          renderPanels();
        });
      }
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
      // Before they arrive, the one it was opened for (a DM invite) has a name.
      if (ctx.role === 'host') return live.guest ? live.guest.name : (ctx.expect && ctx.expect.name) || 'Guest';
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
      if (from === peer()) live.lastPeer = now;
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
        else if (live.phase === 'over') { live.peerGone = true; api.renderReady(); }
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
      else if (live.phase === 'over') { live.peerGone = true; api.renderReady(); }
    }
    // The guest says it is still there; the host notices when it is not.
    // After the battle both sides say so, while the debrief offers a rematch.
    setInterval(function () {
      if (!isLive() || !live) return;
      if (live.phase === 'over' && ctx.role !== 'watch' && !live.peerGone) { sendFrame({ v: 1, kind: 'ping' }); api.renderReady(); return; }
      if (live.phase !== 'battle') return;
      if (ctx.role === 'guest') sendFrame({ v: 1, kind: 'ping' });
      if (ctx.role === 'host' && Date.now() - live.lastGuest > GUEST_GONE_MS) guestLeft({ gone: true });
    }, PING_MS / 2);
    /* How the other side is doing, for the battle bar. */
    function connection() {
      if (!isLive() || !live) return null;
      // The debrief: connected while the other side still answers.
      if (live.phase === 'over') {
        if (ctx.role === 'watch' || live.peerGone || !live.lastPeer) return null;
        return Date.now() - live.lastPeer <= PING_MS * 1.5 ? { state: 'ok', text: linkText() } : null;
      }
      if (live.phase !== 'battle') return null;
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
    function me() { return view && view.me; }
    function myEntry() { var m = me(); return ((view && view.ladder) || []).filter(function (e) { return e.sender === m; })[0] || null; }
    function myId() { return (ctx && ctx.me) || (view && view.me) || null; }
    function runs(n) { return n + (n === 1 ? ' run' : ' runs'); }
    /* A message's clock, as the Comms rows give it: hours and minutes. */
    function clock(ts) {
      if (!ts) return null;
      var d = new Date(Number(ts));
      if (isNaN(d.getTime())) return null;
      return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    }

    /* The panel's header: the round's glyph, what it is, and its right slot. */
    function headNode(title, right) {
      var h = de('header', 'd-panel-h');
      h.appendChild(D.glyph('raid', 16));
      h.appendChild(de('span', null, title));
      var r = de('span', 'd-panel-r');
      (right || []).forEach(function (n) { if (n) r.appendChild(n); });
      h.appendChild(r);
      return h;
    }
    /* The battle's name, and who set it and where. */
    function identNode(compact) {
      var box = de('div', 's-ident');
      var name = battleName();
      var t = de('h2', 'd-name', name);
      t.title = name;
      box.appendChild(t);
      var a = !isLive() && view && view.author;
      if (a) {
        var by = de('div', 's-by');
        by.appendChild(D.pf(a.pfp_attrs || null, { size: compact ? 24 : 32, tone: compact ? 'bare' : null }));
        by.appendChild(de('span', 'd-lbl d-violet s-by-n', String(a.name || '')));
        if (view.room_name) by.appendChild(de('span', 'd-txt d-hint s-by-w', String(view.room_name)));
        box.appendChild(by);
      }
      return box;
    }
    /* The battle's settings as pills, straight from its code. A guest flies
     * the other fleet, so its charge reads its own side first. */
    var LEVEL = { easy: 1, difficult: 2, hard: 3 };
    function chargeText(c, flip) {
      return 'Charge ' + (flip ? c.charge.computer + ' · ' + c.charge.player : c.charge.player + ' · ' + c.charge.computer);
    }
    function pillsNode(c, phase, compact) {
      var box = de('div', 's-pills');
      if (phase) box.appendChild(phase);
      if (!c) return box;
      if (!isLive()) box.appendChild(D.pill({ chevs: LEVEL[c.difficulty] || 1, text: cap(c.difficulty), title: 'Opponent' }));
      var ms = isLive() ? (ctx.block_ms || 4000) : c.blockMs;
      box.appendChild(D.pill({ text: (ms / 1000) + ' s', title: 'Block time' }));
      if (c.charge && !compact) box.appendChild(D.pill({ text: chargeText(c, isLive() && ctx.role === 'guest'), title: 'Opening charge' }));
      return box;
    }
    function lockNode(text) {
      var l = de('div', 's-lock');
      l.appendChild(D.glyph('blocked', 16));
      l.appendChild(de('span', 'd-lbl-sm', text));
      return l;
    }
    function emptyNode(text) { return de('p', 'd-txt d-hint s-empty', text); }

    /* Who played it, best first: the Comms card's own ladder (simcard.js),
     * worn as a deck ladder — its rows keep their .chl-* hooks and gain the
     * deck's: the verdict becomes its glyph, the time takes its colour. */
    function ladderNode(max, fresh) {
      var S = window.StructsSimCard;
      var list = S && view ? S.ladderList(view, { max: max, compact: true }) : null;
      if (!list) return emptyNode(view ? 'Nobody has played it yet' : (viewError || 'Reading the ladder…'));
      list.classList.add('d-ladder');
      list.setAttribute('role', 'list');
      Array.prototype.forEach.call(list.querySelectorAll('.chl-run'), function (row) {
        var mine = row.classList.contains('chl-me');
        row.classList.add('d-lrow');
        row.setAttribute('role', 'listitem');
        if (mine) row.classList.add('is-me');
        if (mine && fresh) row.classList.add('is-fresh');
        var n = row.querySelector('.chl-rank');
        if (n) n.classList.add('d-lrow-n');
        var nm = row.querySelector('.pc-name, .pc-nm');
        if (nm) nm.classList.add('d-lrow-name');
        // Your own run reads You; the name stays in its title.
        if (nm && mine) { nm.title = nm.textContent; nm.textContent = 'You'; }
        var v = row.querySelector('.chl-verdict'), t = row.querySelector('.chl-time');
        var tone = !v ? 'hint' : v.classList.contains('sc-ok') ? 'teal' : v.classList.contains('sc-tone-warning') ? 'amber' : 'coral';
        if (t) t.classList.add('d-lrow-t', 'd-' + tone);
        if (v) {
          var word = v.textContent;
          v.replaceChildren(D.glyph(tone === 'teal' ? 'success' : 'close', 16, 'd-' + tone));
          v.setAttribute('role', 'img');
          v.setAttribute('aria-label', word);
          v.title = word;
        }
      });
      var more = list.querySelector('.chl-more');
      if (more) more.classList.add('d-txt', 'd-hint');
      return list;
    }
    /* The talk, read-only: the thread's last replies as deck messages. The
     * conversation itself is the Map Viewer's Comms rail and Comms. */
    function msgNode(m) {
      var self = !!m.self || (!!m.sender && m.sender === myId());
      var foe = !self && isLive() && players().indexOf(m.sender) !== -1;
      return D.msg({ name: self && isLive() ? 'You' : String(m.name || m.sender || ''), time: clock(m.ts), body: String(m.body || ''), self: self, foe: foe });
    }
    function threadNode(list, empty) {
      var box = de('div', 'd-thread sim-thread');
      list.forEach(function (r) { box.appendChild(msgNode(r)); });
      if (!list.length) box.appendChild(emptyNode(empty));
      return box;
    }
    function section(label, value, node) {
      var s = D.sec(label, value);
      s.root.appendChild(node);
      return s.root;
    }

    /* The conversation the Map Viewer's own Comms rail shows beside the
     * battle (raidview-comms.js, sim mode; simulator.js answers its calls):
     * a live battle's room — the DM it was played in, or its match room — or
     * the challenge's thread. Null when the battle has nobody to talk to. */
    function threadRoomId() { return 'sim-thread:' + (ctx && ctx.event_id); }
    function talkable(m) { return !!m && !m.sim && (m.kind === 'text' || m.kind === 'emote'); }
    function talk() {
      if (isLive()) {
        var who = opponentName();
        var topic = battleName() + (who ? ' · with ' + who : ' · live');
        return {
          room: { room_id: ctx.match_room, guild_id: ctx.guild_id, topic: topic, empty: 'Nothing has been said yet.' },
          timeline: function () {
            return invoke('matrix_timeline', { guildId: ctx.guild_id, roomId: ctx.match_room, limit: 40 }).then(function (t) {
              var r = (t && t.room) || {};
              return { room: { name: r.name || '', topic: topic }, messages: ((t && t.messages) || []).filter(function (m) { return talkable(m) && audible(m); }) };
            });
          },
          send: function (body, msgtype) { return invoke('matrix_send', { guildId: ctx.guild_id, roomId: ctx.match_room, body: body, msgtype: msgtype }); },
        };
      }
      // The challenge's own battle: locked to it, and — once one has run —
      // the run is that battle.
      if (isChallenge() && !left && (!api.initial() || matches(api.initial()))) {
        var asked = ctx;
        var title = battleName() + ' · thread';
        return {
          room: { room_id: threadRoomId(), guild_id: ctx.guild_id, topic: title, empty: 'Nobody has replied yet.' },
          timeline: function () {
            return invoke('matrix_sim_thread', { guildId: asked.guild_id, roomId: asked.room_id, eventId: asked.event_id }).then(function (v) {
              if (ctx === asked) { view = v; renderPanels(); }
              return { room: { name: (v && v.room_name) || '', topic: title }, messages: ((v && v.replies) || []).map(function (r) {
                return { kind: 'text', event_id: r.event_id, sender: r.sender, sender_name: r.name, sender_tag: r.tag || null,
                  player_id: r.player_id || null, body: String(r.body || ''), ts: r.ts, self: !!r.self };
              }) };
            });
          },
          // Plain text into the thread; the rail has already turned `/me` into
          // an emote, which a thread reply does not carry.
          send: function (body) {
            return invoke('matrix_sim_reply', { guildId: asked.guild_id, roomId: asked.room_id, eventId: asked.event_id, body: body });
          },
        };
      }
      return null;
    }

    /* A live battle: what it is, the two seats, and the match's own talk.
     * Each seat says only what that player owes the lobby. */
    var PHASE = { lobby: ['Lobby', 'amber', false], battle: ['Live', 'coral', true], over: ['Ended', null, false] };
    function liveBody(body) {
      var c = Code.decode(ctx.battle);
      var ph = PHASE[live.phase] || PHASE.lobby;
      var top = de('div', 'd-sec');
      top.appendChild(pillsNode(c, D.pill({ text: ph[0], tone: ph[1], led: ph[2], cls: 's-phase' })));
      if (live.phase === 'lobby') top.appendChild(lockNode('Fleets fixed'));
      body.appendChild(top);
      var fin = live.phase === 'over' ? (api.summary().finished || {}) : null;
      // 'you' in a summary is this window's own side; a watcher sees the host's.
      var hostWon = !!fin && (ctx.role === 'guest' ? fin.winner === 'cpu' : fin.winner === 'you');
      var guestWon = !!fin && (ctx.role === 'guest' ? fin.winner === 'you' : fin.winner === 'cpu');
      function seat(p, mine, ready, won, isHost) {
        var pill = live.phase === 'lobby' ? D.pill({ text: ready ? 'Ready' : 'Not ready', tone: ready ? 'teal' : 'amber' })
          : won ? D.pill({ text: 'Won', tone: 'teal', glyph: 'success' }) : de('span');
        var row = D.lrow({ seat: true, pfAttrs: p.pfp || null, name: String(p.name || ''), me: mine, pill: pill });
        row.classList.add('sim-seat');
        if (isHost) row.classList.add('sim-run');
        return row;
      }
      var mine = live.me || {};
      var hostMine = ctx.role === 'host', guestMine = ctx.role === 'guest';
      var rows = [seat(hostMine ? { name: 'You', pfp: mine.pfp_attrs } : { name: ctx.host_name, pfp: ctx.host_pfp }, hostMine, live.ready.host, hostWon, true)];
      if (live.guest) {
        rows.push(seat(guestMine ? { name: 'You', pfp: mine.pfp_attrs } : { name: live.guest.name, pfp: live.guest.pfp_attrs }, guestMine, live.ready.guest, guestWon, false));
      }
      var seats = de('div', 's-seats');
      seats.appendChild(D.ladder(rows));
      if (!live.guest) seats.appendChild(emptyNode(ctx.expect ? 'Waiting for ' + ctx.expect.name : 'Waiting for someone to accept'));
      body.appendChild(section('Players', (live.guest ? 2 : 1) + ' of 2', seats));
      var said = live.chat.filter(audible).slice(-6);
      body.appendChild(section(ctx.role === 'watch' ? 'Watchers and players' : 'Match chat', said.length ? String(said.length) : null,
        threadNode(said, 'Nothing has been said yet')));
    }

    /* Saying something to the match, from the lobby: the deck's composer,
     * built once so a re-render never takes the half-typed line or focus. */
    var chat = null;
    function composerNode() {
      if (!chat) {
        var input = de('input');
        input.type = 'text'; input.id = 'match-say';
        input.placeholder = 'Say something'; input.maxLength = 500;
        input.autocomplete = 'off'; input.spellcheck = false;
        input.setAttribute('aria-label', 'Message the match');
        var send = D.btn({ tone: 'teal', square: true, glyph: 'send-alpha', ariaLabel: 'Send', title: 'Send' });
        chat = D.composer({ input: input, send: send });
        chat.root.classList.add('s-say');
        input.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); say(); } });
        send.addEventListener('click', say);
      }
      var attrs = (live && live.me && live.me.pfp_attrs) || null;
      if (chat.pfFor !== attrs) {
        chat.root.replaceChild(D.pf(attrs, { size: 48, tone: 'you' }), chat.root.firstChild);
        chat.pfFor = attrs;
      }
      return chat.root;
    }
    function say() {
      var t = talk(), body = chat.input.value.trim();
      if (!t || !body || chat.busy) return;
      chat.busy = true; chat.send.disabled = true;
      t.send(body, null)
        .then(function () { chat.input.value = ''; loadMatchChat(); })
        .catch(function (e) { api.message('Not sent — ' + errText(e)); })
        .then(function () { chat.busy = false; chat.send.disabled = false; });
    }

    /* The Challenge / Live panel: in Setup, in the Mission panel's place (its
     * footer — Edit fleets, or the composer — is the page's own markup); in
     * the Debrief, a challenge's compact ladder beside the tally (a live
     * battle's debrief is the head-to-head band, as drawn). */
    function panel(box, key) {
      if (!box) return;
      var isDb = key === 'debrief';
      var show = isDb ? isChallenge() : isLive() || (isChallenge() && !left);
      box.classList.toggle('hidden', !show);
      if (!show) return;
      if (isDb) box.className = 'd-panel x-chal is-warn';
      else { box.classList.toggle('is-warn', !isLive()); box.classList.toggle('is-enemy', isLive()); }
      var main = isDb ? box : (box.querySelector('#challenge-main') || box);
      main.replaceChildren();
      var c = ctx && Code.decode(ctx.battle);
      var lad = (view && view.ladder) || [];
      var title = isLive() ? (ctx.role === 'watch' ? 'Watching' : 'Live battle') : 'Challenge';
      var right = isDb ? de('span', null, runs(lad.length))
        : D.iconBtn({ glyph: 'close', label: isLive() ? 'Leave the battle' : 'Leave the challenge', onClick: leave });
      main.appendChild(headNode(title, [right]));
      var body = de('div', 'd-panel-b' + (isDb ? ' is-tight' : ''));
      main.appendChild(body);
      body.appendChild(identNode(isDb));
      if (isLive()) {
        liveBody(body);
      } else if (isDb) {
        // Compact: the name, the ladder flush, and the settings as one hint
        // line in the footer.
        var flush = de('div', 'd-panel-b is-flush');
        flush.appendChild(ladderNode(50, !!post && post.state === 'posted'));
        main.appendChild(flush);
        if (!left) {
          var foot = de('footer', 'd-panel-f x-chal-f');
          foot.appendChild(D.glyph('blocked', 16, 'd-hint'));
          foot.appendChild(de('span', 'd-txt d-hint', ['Fleets fixed'].concat(c ? [cap(c.difficulty), (c.blockMs / 1000) + ' s'] : []).join(' · ')));
          main.appendChild(foot);
        }
      } else {
        var set = de('div', 'd-sec');
        set.appendChild(pillsNode(c, null));
        set.appendChild(lockNode('Fleets fixed'));
        body.appendChild(set);
        if (viewError && view) body.appendChild(emptyNode(viewError));
        body.appendChild(section('Ladder', runs(lad.length), ladderNode(3, false)));
        body.appendChild(section('Thread', String((view && view.reply_count) || 0),
          threadNode(((view && view.replies) || []).slice(-2), 'Nobody has replied yet')));
      }
      if (!isDb) {
        var f = box.querySelector('.d-panel-f');
        var talking = isLive() && ctx.role !== 'watch';
        if (f && talking) { var cn = composerNode(); if (cn.parentNode !== f) f.appendChild(cn); }
        else if (chat && chat.root.parentNode) chat.root.parentNode.removeChild(chat.root);
        if (f) f.classList.toggle('hidden', isLive() && !talking);
      }
    }

    /* The window's name for what this round is, at the head of the top bar. */
    function renderMode() {
      var m = $('sim-mode');
      if (!m) return;
      var text;
      if (isLive() && ctx.role === 'watch') {
        D.mode(m, { text: text = 'Watching', tone: 'live', glyph: 'raid' });
      } else if (isLive()) {
        var who = opponentName();
        var attrs = ctx.role === 'guest' ? ctx.host_pfp : (live.guest && live.guest.pfp_attrs);
        D.mode(m, { text: text = 'Live · ' + (who || 'Guest'), tone: 'live', pfAttrs: attrs || null });
      } else if (isChallenge() && !left) {
        D.mode(m, { text: text = 'Challenge', tone: 'challenge', glyph: 'raid' });
      } else {
        D.mode(m, { text: text = 'Simulator', glyph: 'computer' });
      }
      m.title = text;
    }

    function renderPanels() {
      renderMode();
      panel($('challenge'), 'setup');
      panel($('db-challenge'), 'debrief');
      if ($('db-challenge') && (document.body.dataset.screen !== 'debrief' || !isChallenge())) $('db-challenge').classList.add('hidden');
      document.body.classList.toggle('sim-live', isLive());
      renderStart();
      renderPost();
    }

    // ── setup ────────────────────────────────────────────────────────────
    function reveal(id, on) { var n = $(id); if (n) n.classList.toggle('hidden', !on); }
    function portraitInto(id, attrs) {
      var n = $(id);
      if (!n) return;
      n.replaceChildren();
      if (window.StructsPfp) window.StructsPfp.fillPortrait(n, attrs || null);
    }
    function renderSetup() {
      var lockedNow = locked();
      reveal('round', !lockedNow);
      reveal('unlock', lockedNow && !isLive());
      reveal('relock', isChallenge() && left);
      // The board's whole-fleet tools stay in place, switched off.
      ['mirror', 'swap'].forEach(function (id) { if ($(id)) $(id).disabled = lockedNow; });
      // The other side of the board is a person in a live battle.
      var cpuName = document.querySelector('#fleet-head .sim-cpu');
      if (cpuName) cpuName.textContent = opponentName() || 'Computer';
      var to = addressed();
      reveal('addressed', !!to);
      reveal('send-to', !!to);
      reveal('live-to', !!to);
      reveal('live-room', isChallenge() && !left);
      if (to) {
        var name = String(to.name || '');
        if ($('addressed-name')) $('addressed-name').textContent = name;
        portraitInto('addressed-pfp', to.pfp_attrs);
        var clear = $('addressed-clear');
        if (clear) { clear.setAttribute('aria-label', 'Stop setting this up for ' + name); clear.title = 'Stop setting this up for ' + name; }
        var send = $('send-to');
        if (send) {
          send.title = 'Send to ' + name;
          if ($('send-to-name')) $('send-to-name').textContent = name;
          else if (send.querySelector('span')) send.querySelector('span').textContent = 'Send to ' + name;
          portraitInto('send-to-pfp', to.pfp_attrs);
        }
        var lt = $('live-to');
        if (lt) { lt.title = 'Play ' + name + ' live'; if (lt.querySelector('span')) lt.querySelector('span').textContent = 'Play ' + name + ' live'; }
      }
      renderPanels();
    }

    /* The launch key: Start battle, or in a live lobby, Ready. */
    function renderStart() {
      var b = $('start');
      if (!b) return;
      var label = b.querySelector('span') || b.insertBefore(document.createElement('span'), b.firstChild);
      if (!isLive()) { label.textContent = 'Start battle'; return; }
      var mine = ctx.role === 'host' ? live.ready.host : live.ready.guest;
      label.textContent = live.phase !== 'lobby' ? 'Started' : mine ? 'Ready · waiting' : 'Ready';
      b.disabled = live.phase !== 'lobby' || ctx.role === 'watch';
    }

    // The battle screen talks through the Map Viewer's own rail (`talk`).
    function renderBattle() {}

    // ── debrief ──────────────────────────────────────────────────────────
    /* Head-to-head, this window's session: rematches in the same window add
     * up. Keyed by the other player; nothing is kept past the window. */
    var series = {};
    function opponentKey() {
      if (!isLive()) return null;
      if (ctx.role === 'host') return live.guest ? (live.guest.player_id || live.guest.user) : null;
      return ctx.host_player_id || ctx.host;
    }
    function opponentPfp() { return ctx.role === 'host' ? (live.guest && live.guest.pfp_attrs) || null : ctx.host_pfp || null; }

    /* After a run: into the thread if it is your best on this challenge, to
     * the person if the battle is addressed, otherwise nothing — Share is
     * there for that. */
    function debrief(config, result) {
      lastRun = { config: config, result: result };
      post = null;
      if (isLive()) {
        live.phase = 'over';
        var f = api.summary().finished || {};
        if (ctx.role === 'host') {
          var winner = f.winner === 'you' ? 'host' : f.winner === 'cpu' ? 'guest' : 'draw';
          var end = { v: 1, kind: 'end', winner: winner, forfeit: !!f.forfeit, stalemate: f.stalemate || null, gone: !!f.gone, summary: api.summary() };
          if (live.link) live.link.after(end); else sendFrame(end);
          sendStatus({ state: 'ended', guest: live.guest && live.guest.user, winner: winner === 'host' ? ctx.host : winner === 'guest' ? live.guest && live.guest.user : null });
        }
        var key = ctx.role !== 'watch' && opponentKey();
        if (key) {
          var sc = series[key] || (series[key] = { you: 0, them: 0 });
          if (f.winner === 'you') sc.you++; else if (f.winner === 'cpu') sc.them++;
        }
        post = { state: 'live' };
        renderPanels();
        return;
      }
      if (matches(config)) {
        // Your standing before this run: the new best says what it beat.
        var was = myEntry();
        var prevBest = was && was.outcome ? was.outcome.time : null;
        post = { state: 'posting' };
        renderPost();
        invoke('matrix_sim_post', { guildId: ctx.guild_id, roomId: ctx.room_id, battle: ctx.battle, result: result, thread: ctx.event_id })
          .then(function (r) {
            post = r && r.posted ? { state: 'posted', event_id: r.event_id, top: r.top, beat: r.beat, prevBest: prevBest } : { state: 'kept' };
            refresh(true);
            renderPanels();
          })
          .catch(function (e) { post = { state: 'failed', error: errText(e) }; renderPost(); });
      } else if (isChallenge()) {
        post = { state: 'edited' };
      } else if (addressed()) {
        post = { state: 'send' };
      }
      renderPanels();
    }

    /* What became of the run: the deck's alert band — teal when it went
     * well, coral when it failed, neutral for anything in between — its
     * action at the end. A live battle between two is the head-to-head. */
    var TONE = { good: 'teal', bad: 'coral', quiet: 'neutral' };
    function band(tone, head, detail, sub, actions) {
      var box = $('db-post');
      box.className = '';
      var t = TONE[tone] || 'neutral';
      D.alert({ into: box, tone: t, cls: 'is-' + t, head: head, detail: detail || '', sub: sub || null, actions: actions || [] });
    }
    function hidePost(box) { box.className = 'hidden'; box._dkCls = null; box.replaceChildren(); }
    function headToHead(fin, other, name) {
      var box = $('db-post');
      box.className = 'x-h2h';
      box._dkCls = null;
      box.replaceChildren();
      var sc = series[opponentKey()] || { you: 0, them: 0 };
      box.appendChild(de('span', 'd-lbl d-hint x-h2h-l', 'Head-to-head'));
      var score = de('div', 'x-score');
      score.appendChild(D.pf((live.me && live.me.pfp_attrs) || null, { size: 48, tone: 'you' }));
      score.appendChild(de('span', 'd-lbl d-teal', 'You'));
      score.appendChild(de('span', 'd-num x-score-n d-teal', sc.you));
      score.appendChild(de('span', 'd-num x-score-n d-hint', '-'));
      score.appendChild(de('span', 'd-num x-score-n d-coral', sc.them));
      score.appendChild(de('span', 'd-lbl d-coral x-score-who', other));
      score.appendChild(D.pf(opponentPfp(), { size: 48, tone: 'them' }));
      box.appendChild(score);
      var line = fin.winner === 'you' ? 'You beat ' + other : fin.winner === 'cpu' ? other + ' beat you' : 'A draw with ' + other;
      var why = fin.gone ? (fin.winner === 'you' ? other + ' left' : 'the connection dropped') : fin.forfeit ? 'forfeit' : null;
      box.appendChild(de('span', 'd-txt d-hint x-h2h-t', [name, line, why].filter(Boolean).join(' · ')));
    }

    function renderPost() { drawPost(); }
    function drawPost() {
      var box = $('db-post');
      if (!box) return;
      if (!post || document.body.dataset.screen !== 'debrief') { hidePost(box); return; }
      var name = battleName();
      var mine = myEntry();
      var lad = (view && view.ladder) || [];
      var where = view && view.room_name ? view.room_name + ' · thread' : 'the thread';
      if (post.state === 'live') {
        var fin = api.summary().finished || {};
        var other = opponentName() || (ctx.role === 'watch' ? 'the guest' : '');
        if (ctx.role === 'watch') {
          return band('quiet', fin.winner === 'draw' ? 'A draw' : (fin.winner === 'you' ? ctx.host_name : (live.guest && live.guest.name) || 'The guest') + ' won', 'live · ' + name);
        }
        return headToHead(fin, other, name);
      }
      if (post.state === 'posting') return band('quiet', 'Posting your best…', where);
      if (post.state === 'posted') {
        var undo = D.tool({ glyph: 'chevron-left', text: 'Undo', title: 'Take the post back', onClick: function () {
          undo.disabled = true;
          invoke('matrix_redact', { guildId: ctx.guild_id, roomId: ctx.room_id, eventId: post.event_id })
            .then(function () { post = { state: 'undone' }; refresh(true); renderPanels(); })
            .catch(function (e) { undo.disabled = false; api.message('Not undone — ' + errText(e)); });
        } });
        var place = (mine ? ordinal(mine.rank) + ' of ' + lad.length + ' on ' + name : 'on ' + name) + (post.prevBest ? ' · was ' + post.prevBest : '');
        return band('good', post.top ? 'New best · posted' : 'Your best · posted', place, view && view.room_name ? 'to ' + view.room_name : null, [undo]);
      }
      if (post.state === 'kept') {
        return band('quiet', mine ? 'Your best stays ' + mine.outcome.time : 'Not posted',
          mine ? ordinal(mine.rank) + ' of ' + lad.length + ' on ' + name + ' · this run stays here' : 'this run stays here');
      }
      if (post.state === 'undone') return band('quiet', 'Taken back', 'this run stays here');
      if (post.state === 'edited') return band('quiet', 'Your own battle', 'edited fleets · not on the ' + name + ' ladder');
      if (post.state === 'failed') {
        return band('bad', 'Not posted', post.error, null, [D.tool({ glyph: 'refresh-12', text: 'Try again', onClick: function () {
          if (lastRun) debrief(lastRun.config, lastRun.result);
        } })]);
      }
      var to = addressed();
      if (to && (post.state === 'send' || post.state === 'sending')) {
        var go = D.btn({ tone: 'violet', text: 'Send to ' + to.name, glyph: 'outgoing', disabled: post.state === 'sending', onClick: function () {
          post = { state: 'sending' }; renderPost();
          invoke('matrix_sim_post', { toPlayer: to.player_id, battle: codeOf(lastRun.config), result: lastRun.result })
            .then(function () { post = { state: 'sent' }; renderPost(); })
            .catch(function (e) { post = { state: 'send' }; renderPost(); api.message('Not sent — ' + errText(e)); });
        } });
        return band('quiet', 'For ' + to.name, 'your run is the time to beat', null, [go]);
      }
      if (to && post.state === 'sent') return band('good', 'Sent to ' + to.name, 'in your DM');
      hidePost(box);
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
    /* A deck dialog (SimDeck.modal), built when it opens and gone when it
     * closes. What it holds is built once, so its ids and handlers stay put:
     * what is being shared, a find field, and the rooms as radio rows — each
     * marked by the same StructsChatRow parts the Comms channel list uses, so
     * a room looks the same in both. */
    var postTo = { rooms: [], guild: null, pick: null, config: null, result: null, line: '', modal: null };
    var postWhat = de('p', 'd-txt d-hint s-post-what');
    postWhat.id = 'post-what';
    var postFind = de('input', 'd-code-in');
    postFind.type = 'text'; postFind.id = 'post-find';
    postFind.placeholder = 'Find a player or room';
    postFind.autocomplete = 'off'; postFind.spellcheck = false;
    var postField = de('div', 'd-sec');
    var postFindLabel = de('label', 'd-lbl d-hint', 'Post to');
    postFindLabel.htmlFor = 'post-find';
    var postFindBox = de('span', 'd-code');
    postFindBox.appendChild(postFind);
    postField.appendChild(postFindLabel);
    postField.appendChild(postFindBox);
    var postRooms = de('div', 's-rooms');
    postRooms.id = 'post-rooms';
    postRooms.setAttribute('role', 'radiogroup');
    postRooms.setAttribute('aria-label', 'Post to');
    var postCopy = D.btn({ id: 'post-copy', text: 'Copy link', glyph: 'copy', onClick: function () {
      var c = postTo.config, r = postTo.result, l = postTo.line;
      closePost();
      api.copyFor(c, r, l);
    } });
    var postSendBtn = D.btn({ id: 'post-send', tone: 'teal', text: 'Post', glyph: 'send-alpha', disabled: true, onClick: function () { sendPost(); } });
    function postSend() { return postTo.modal ? postSendBtn : null; }

    function openPost(config, result, line) {
      closePost();
      postTo.config = config; postTo.result = result || null; postTo.line = line || '';
      var c = config;
      postWhat.textContent = line || ((c.seed ? cap(c.seed) : 'Battle') + ' · ' + cap(c.difficulty));
      postFind.value = '';
      postTo.shown = [];
      postTo.pick = null;
      pickRoom(null);
      postRooms.replaceChildren(emptyNode('Reading your rooms…'));
      var m = D.modal({
        id: 'post-dialog', parent: $('menu-page-layout'), width: 'md', tone: 'violet', railGlyph: 'outgoing',
        title: result ? 'Share result' : 'Share battle', titleId: 'post-title', role: 'dialog',
        body: [postWhat, postField, postRooms], cta: [postCopy, postSendBtn],
        focus: postFind, backdropCancels: true, onCancel: closePost,
      });
      postTo.modal = m;
      m.show();
      pickRoom(null);
      invoke('matrix_sim_rooms').then(function (r) {
        if (postTo.modal !== m) return;
        postTo.rooms = (r && r.rooms) || []; postTo.guild = r && r.guild_id;
        var to = addressed();
        postTo.pick = null;
        if (to) postTo.pick = (postTo.rooms.filter(function (x) { return x.player_id === to.player_id; })[0] || {}).room_id || null;
        // Nothing is picked for you: one click must never post to whoever
        // happens to be first in the list.
        roomList();
      }).catch(function (e) {
        if (postTo.modal === m) postRooms.replaceChildren(emptyNode(errText(e)));
      });
    }
    function closePost() {
      var m = postTo.modal;
      postTo.modal = null;
      if (m) m.close();
    }
    var markParts = { icon: function (name) { return D.glyph(String(name).replace(/^icon-/, '')); } };
    function roomRow(r) {
      var row = de('label', 's-room');
      var input = de('input', 'd-sr');
      input.type = 'radio'; input.name = 'post-room'; input.value = r.room_id;
      input.checked = postTo.pick === r.room_id;
      input.addEventListener('change', function () { if (input.checked) pickRoom(r.room_id); });
      row.appendChild(input);
      var R = window.StructsChatRow;
      row.appendChild(R.roomMark(r, markParts));
      var nm = String(r.name || r.room_id);
      row.appendChild(de('span', 'd-txt s-room-n', nm));
      row.appendChild(de('span', 'd-txt d-hint s-room-sub', R.roomSub(r) || ''));
      row.title = nm;
      return row;
    }
    function roomList() {
      var q = postFind.value.trim().toLowerCase();
      var list = postTo.rooms.filter(function (r) { return !q || String(r.name || '').toLowerCase().indexOf(q) !== -1; });
      postRooms.replaceChildren();
      if (!list.length) postRooms.appendChild(emptyNode(postTo.rooms.length ? 'No room by that name' : 'No rooms yet'));
      list.forEach(function (r) { postRooms.appendChild(roomRow(r)); });
      postTo.shown = list;
      pickRoom(postTo.pick);
    }
    /* Post waits for a pick the list shows, and names where it posts. */
    function pickRoom(id) {
      postTo.pick = id;
      var picked = (postTo.shown || []).filter(function (r) { return r.room_id === postTo.pick; })[0];
      var b = postSendBtn;
      b.disabled = !picked;
      var label = picked ? 'Post to ' + (picked.name || 'the room') : 'Post';
      var span = b.querySelector('span');
      if (span) span.textContent = label;
      b.title = label;
    }
    function sendPost() {
      var code = codeOf(postTo.config);
      if (!code || !postTo.pick || !postSend()) return;
      var m = postTo.modal, b = postSendBtn;
      b.disabled = true;
      invoke('matrix_sim_post', { guildId: postTo.guild, roomId: postTo.pick, battle: code, result: postTo.result })
        .then(function () {
          var picked = postTo.rooms.filter(function (r) { return r.room_id === postTo.pick; })[0];
          if (postTo.modal === m) closePost();
          api.message('Posted to ' + (picked ? picked.name : 'the room') + '.');
        })
        .catch(function (e) { if (postTo.modal === m) b.disabled = false; api.message('Not posted — ' + errText(e)); });
    }
    postFind.addEventListener('input', roomList);
    function bind(id, fn) { var n = $(id); if (n) n.addEventListener('click', fn); }
    bind('send-to', sendNow);
    bind('addressed-clear', leave);
    bind('live-to', function () { var to = addressed(); if (to) openLive({ toPlayer: to.player_id }); });
    bind('live-room', function () { if (isChallenge()) openLive({ guildId: ctx.guild_id, roomId: ctx.room_id }); });
    $('unlock').addEventListener('click', unlock);
    bind('relock', relock);

    return {
      take: take, adopt: adopt, isChallenge: isChallenge, locked: locked, matches: matches, addressed: addressed,
      renderSetup: renderSetup, renderBattle: renderBattle, renderPanels: renderPanels, debrief: debrief,
      openPost: openPost, closePost: closePost, leave: leave, battleName: battleName,
      context: function () { return ctx; }, view: function () { return view; },
      talk: talk, isLive: isLive, liveRole: function () { return isLive() ? ctx.role : null; }, onStart: onStart, openLive: openLive,
      opponentName: opponentName, connection: connection, swapped: function (c) { return api.swapped(c); },
      /* A live battle's lobby, for the command bar: who has readied. */
      lobby: function () {
        if (!isLive() || !live || live.phase !== 'lobby') return null;
        var host = ctx.role === 'host';
        return { role: ctx.role, mine: !!(host ? live.ready.host : live.ready.guest), theirs: !!(host ? live.ready.guest : live.ready.host),
          other: host ? (live.guest ? live.guest.name : null) : ctx.host_name };
      },
      rematch: function () {
        if (!isLive() || ctx.role !== 'host') return false;
        var g = live.guest, t = ctx.target || {};
        openLive(g && g.player_id ? { toPlayer: g.player_id } : t);
        return true;
      },
    };
  };
})();
