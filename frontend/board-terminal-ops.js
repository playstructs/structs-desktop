// STRUCTS TERMINAL — the operations cards.
//
// The same data Team Ops shows, one concern per card, drawn for a column
// instead of a page: hashing (the proof queue, solve rates, the tasks),
// signing (the queue, the results), power (guild grid, reactor fuel,
// allocations), the fleet roster, raids, war (posture, targets, grudges,
// vetoes, incidents), a wallet and the system's health. Every card reads the
// command the page reads and acts through the command the page acts
// through — nothing here is a second copy of a page.
//
// Loaded after board-terminal.js; registers into Board.Terminal.
(function () {
  'use strict';
  var Board = window.Board, T = Board.Terminal, H = Board.helpers;
  var invoke = function (cmd, args) { return Board.T.core.invoke(cmd, args || {}); };
  var add = function (type, params, w) { return T.add(type, params, w); };
  var PC = function () { return window.StructsPlayerCard; };
  var tiles = function (list) {
    var strip = H.el('div', 'hstrip tm-tiles');
    list.forEach(function (t) { strip.appendChild(H.statTile(t[0], t[1], t[2] || null, t[3] || null)); });
    return strip;
  };
  var cap = function (host, text) { var c = H.el('div', 'tm-cap'); c.appendChild(H.el('span', 'fstat-l', text)); host.appendChild(c); return c; };
  var pct = function (v) { var n = typeof v === 'number' ? v : parseFloat(String(v == null ? '' : v)); return isNaN(n) ? 0 : n; };
  var doorRow = function (items) {
    var row = H.el('div', 'tm-doors-row');
    items.forEach(function (it) {
      var a = H.el('a', 'sui-screen-btn ' + (it.primary ? 'sui-mod-primary' : 'sui-mod-secondary'), it.label);
      a.href = 'javascript:void(0)';
      a.addEventListener('click', function () { it.onClick(a); });
      row.appendChild(a);
    });
    return row;
  };
  // ── Tickets ───────────────────────────────────────────────────────────
  // A card that shows something you can change should offer the change. A
  // ticket is the shape that makes that safe: a few fields, a PREVIEW that
  // says what the chain will do, and a confirm before anything is signed.
  // The guild bank card was the first; this is that pattern, shared.
  //
  // spec: { fields:[{key,label,kind:'choice'|'amount'|'text',options,placeholder,value,hint}],
  //         cta, danger, preview(values)->Promise|null, facts(preview)->[[label,value,tone]],
  //         confirm(values,preview)->{title,rows,cta}, submit(values)->Promise, done() }
  var readControl = function (n) { return T.readControl(n); };
  function ticket(spec) {
    var box = H.el('div', 'tm-ticket');
    var inputs = {}, timer = null, last = null;
    var out = H.el('div', 'tm-ticket-note');
    var go = H.el('a', 'sui-screen-btn ' + (spec.danger ? 'sui-mod-destructive' : 'sui-mod-primary'), spec.cta || 'Sign');
    go.href = 'javascript:void(0)';

    function values() {
      var v = {};
      Object.keys(inputs).forEach(function (k) { v[k] = readControl(inputs[k]); });
      return v;
    }
    /* `seed` is what the fields held BEFORE the rebuild.
     *
     * A field function that depends on another field — the free SLOTS of the
     * chosen ambit, say — was asked for its shape after `inputs` had already
     * been cleared, so it read an empty form and offered the first ambit's
     * slots whichever ambit you picked. */
    function paintFields(seed) {
      var fields = H.el('div', 'tm-ticket-fields');
      // A ticket with nothing to fill in is a real shape — "Return home" has
      // one answer — so no `fields` means no fields, not a crash.
      (typeof spec.fields === 'function' ? spec.fields(seed || values()) : (spec.fields || [])).forEach(function (f) {
        var ctl;
        if (f.kind === 'choice') ctl = H.selectBox(String(f.value == null ? (f.options[0] || {}).value : f.value), f.options, function () { changed(true); });
        else {
          ctl = H.textBox(f.value == null ? '' : String(f.value), f.placeholder || '', function () { changed(false); });
          ctl.setAttribute('inputmode', 'numeric');
          ctl.addEventListener('input', function () { changed(false); });
        }
        inputs[f.key] = ctl;
        var wrap = H.field(f.label, ctl);
        if (f.hint) wrap.title = f.hint;
        fields.appendChild(wrap);
      });
      var old = box.querySelector('.tm-ticket-fields');
      // First paint: the note and the button are not in the box yet.
      if (old) box.replaceChild(fields, old);
      else if (out.parentNode === box) box.insertBefore(fields, out);
      else box.appendChild(fields);
    }
    function changed(rebuild) {
      if (rebuild && typeof spec.fields === 'function') { var keep = values(); inputs = {}; paintFields(keep); restore(keep); }
      if (timer) clearTimeout(timer);
      timer = setTimeout(runPreview, 250);
    }
    function restore(keep) {
      Object.keys(keep).forEach(function (k) {
        var ctl = inputs[k]; if (!ctl || !keep[k]) return;
        var inner = ctl.value != null && ctl.tagName !== 'DIV' ? ctl : ctl.querySelector && ctl.querySelector('select, input');
        if (inner && inner.tagName === 'INPUT') inner.value = keep[k];
      });
    }
    function runPreview() {
      last = null;
      out.innerHTML = '';
      if (!spec.preview) return;
      var p = spec.preview(values());
      if (!p) return;
      out.appendChild(H.stateBlock('loading', 'checking…'));
      p.then(function (res) {
        out.innerHTML = '';
        (res && res.warnings || []).forEach(function (w) { out.appendChild(H.stateBlock('warning', String(w))); });
        if (res && res.ok === false) { out.appendChild(H.stateBlock('error', String(res.refusal || 'refused'))); return; }
        last = res;
        var facts = spec.facts ? spec.facts(res) : [];
        if (facts.length) out.appendChild(tiles(facts));
      }).catch(function (e) { out.innerHTML = ''; out.appendChild(H.stateBlock('error', String(e))); });
    }
    go.addEventListener('click', function () {
      var v = values();
      var c = spec.confirm ? spec.confirm(v, last) : null;
      var run = function () {
        go.classList.add('is-busy');
        spec.submit(v).then(function () {
          go.classList.remove('is-busy');
          out.innerHTML = ''; out.appendChild(H.stateBlock('info', 'queued for signing'));
          if (spec.done) spec.done();
        }).catch(function (e) {
          go.classList.remove('is-busy');
          out.innerHTML = ''; out.appendChild(H.stateBlock('error', String(e)));
        });
      };
      if (!c) { run(); return; }
      var body = H.el('div');
      (c.rows || []).forEach(function (r) { body.appendChild(H.fact ? H.fact(r[0], r[1]) : H.row(r[0], r[1])); });
      H.confirmModal(c.title, body, c.cta || spec.cta || 'Confirm', run);
    });

    paintFields();
    box.appendChild(out);
    box.appendChild(go);
    runPreview();
    return box;
  }

  var human = function (s) { return String(s || '?').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ').toLowerCase(); };
  var fail = function (host, what, e) { host.innerHTML = ''; host.appendChild(H.stateBlock('error', what + ' unavailable: ' + e)); };

  // ── Hashing (mcp_work) ───────────────────────────────────────────────────
  var TASK_ICON = { MINE: 'icon-mine', REFINE: 'icon-refine', BUILD: 'icon-in-progress', RAID: 'icon-raid' };
  // ── CREW ──────────────────────────────────────────────────────────────
  //
  // A crew is other people's machines finishing your proofs, and yours
  // finishing theirs. Two cards because there are two questions and they are
  // asked at different times: WHO is in it and what is open to whom (this
  // card), and what that costs (the next one).
  //
  // The grant is the part that reads alarming and is not: the chain's
  // `PermHash*` bits gate exactly four completion messages and nothing else,
  // so opening your work hands over no tokens, no structs and no account. The
  // row says which of the four roads the permission came down — owner, a
  // direct grant, or a guild rank — because they expire differently and a
  // single "allowed" could not explain tomorrow's failure.
  /* These chips are about SIGNING rights only. Anybody may compute a proof
   * for anybody — the grinding input is public — so "Closed" here never
   * means "cannot help"; it means "cannot finish it without you". */
  var AUTH_CHIP = {
    owner: ['Yours', 'ok'], granted: ['Granted', 'ok'],
    guild_rank: ['By rank', 'ok'], denied: ['Closed', 'muted'],
  };
  function authChip(label, v) {
    var a = AUTH_CHIP[String(v || 'denied')] || ['Unknown', 'muted'];
    return H.statTile(label, a[0], null, v == null ? 'muted' : a[1]);
  }

  /* Which cards have their friend picker open. A refresh replaces the
   * card's body, and a picker replaced mid-search was the bug that first
   * froze this card's cadence at zero; now the card keeps refreshing and
   * simply leaves a body alone while somebody is typing in it. */
  var PICKER_OPEN = {};

  T.register('crew', {
    label: 'Cluster',
    describe: function () { return 'Cluster'; },
    cadenceMs: 20000,
    render: function (host, p, ctx) {
      if (PICKER_OPEN[ctx.id] && !ctx.first) return Promise.resolve();
      return invoke('crew_links').then(function (d) {
        var links = (d && d.links) || [];
        host.innerHTML = '';
        function refresh() { PICKER_OPEN[ctx.id] = false; T.refresh(ctx.id, true); }

        /* ── Sections, arranged by what the reader needs first ──────────
         *
         * Nobody linked yet: the question is the whole card, so it leads and
         * the bus, rates and recent activity follow as context. Linked: the
         * state leads, the links are the card, and "help someone else" is
         * the afterthought it is. Every section draws nothing when it has
         * nothing true to say. */

        function stateSection() {
          if (!links.length) return;
          var state = [
            ['you are', d.helping ? 'in sync' : 'me', null, d.helping ? 'live' : 'muted'],
            ['doing now', H.fmtInt(d.taking || 0), null, (d.taking || 0) ? 'live' : 'muted'],
            ['finished', H.fmtInt(d.helped || 0)],
          ];
          if (d.reported) state.push(['sent to the cluster', H.fmtInt(d.reported)]);
          host.appendChild(tiles(state));
          /* Two thresholds, side by side: how cheap somebody else's proof
           * must be before this machine grinds it, and the one the harvest
           * loop uses for your own rigs. The first is set here; the second
           * is the harvest loop's own knob and is shown so the two can be
           * read together. */
          if (d.crew_threshold != null) {
            var th = H.el('div', 'tm-doors-row');
            th.appendChild(H.field('Cluster work at difficulty ≤',
              H.stepper(Number(d.crew_threshold) || 1, { min: 1, max: 64, step: 1, width: '3.5em' }, function (nv) {
                invoke('crew_threshold_set', { threshold: Number(nv) })
                  .then(refresh)
                  .catch(function (e) { Board.stamp && Board.stamp('crew: ' + e); });
              })));
            if (d.own_threshold != null) th.appendChild(H.statTile('mine at ≤', String(d.own_threshold), null, 'muted'));
            host.appendChild(th);
          }
          var lp = d.last_pass;
          // Why nothing is happening, as state: what was ripe and what was
          // left alone. The reasons are the loop's own and are in its log.
          if (lp && d.helping && !(d.taking || 0)) {
            if (!lp.ripe) {
              host.appendChild(H.stateBlock('info',
                'Nothing ripe across ' + H.fmtInt(lp.members || 0) + ' in the cluster.'));
            } else if (!lp.started) {
              host.appendChild(H.stateBlock('warning',
                H.fmtInt(lp.ripe) + ' ready · ' + H.fmtInt(lp.declined || 0) + ' left alone'));
            }
          }
          if (lp && lp.started) {
            host.appendChild(tiles([
              ['as proxy', H.fmtInt(lp.submitting || 0), null, (lp.submitting || 0) ? 'live' : 'muted'],
              ['as pheral', H.fmtInt(lp.reporting || 0), null, (lp.reporting || 0) ? 'live' : 'muted'],
              ['for pay', H.fmtInt(lp.paid || 0), null, (lp.paid || 0) ? 'live' : 'muted'],
            ]));
          }
        }

        function busSection() {
          var bus = d.bus || {};
          if (!(bus.last_frame_ms || bus.accepted_total)) return;
          var age = bus.last_frame_ms ? Date.now() - bus.last_frame_ms : null;
          var atCeiling = !!bus.ceiling && (bus.signed_this_hour || 0) >= bus.ceiling;
          var paying = links.some(function (l) { return l.pay_enabled && l.rate; });
          host.appendChild(tiles([
            ['cluster', age == null ? 'quiet' : H.ago(bus.last_frame_ms) + ' ago', null,
              age != null && age < 600000 ? 'live' : 'muted'],
            ['signed this hour', H.fmtInt(bus.signed_this_hour || 0) + ' of ' + H.fmtInt(bus.ceiling || 0), null,
              atCeiling ? 'warn' : null],
            ['spent', H.fmtInt(bus.accepted_total || 0)],
            ['paying pherals', paying ? 'on' : 'off', null, paying ? 'live' : 'muted'],
          ]));
          // The node we transact through, only when it is the problem: a
          // node behind the chain swallows every transaction, and nothing
          // else on this card can explain a bus that is live and a spend
          // count that has stopped.
          if (bus.node_stalled) {
            host.appendChild(H.stateBlock('error',
              'node ' + H.fmtInt(bus.node_lag || 0) + ' blocks behind the chain \u2014 holding proofs until it catches up'));
          }
          if (bus.refused_ceiling) {
            host.appendChild(H.stateBlock('warning',
              H.fmtInt(bus.refused_ceiling) + ' refused at the ceiling · CONFIG › cluster (sign)'));
          }
        }

        function ratesSection() {
          var rates = (d.rates || []).slice(0, 5);
          if (!rates.length) return;
          cap(host, 'Paying in the cluster');
          var rt = H.resultTable();
          rt.classList.add('list-short');
          rates.forEach(function (r) {
            rt.appendChild(H.resultRow({
              icon: 'icon-send-alpha',
              title: String(r.name || r.payer),
              subtitle: amt(r.rate, r.denom || 'ualpha') + ' per difficulty'
                + (r.per_helper_cap ? ' · up to ' + amt(r.per_helper_cap, r.denom || 'ualpha') + ' each' : '')
                + (r.min_payout ? ' · paid from ' + amt(r.min_payout, r.denom || 'ualpha') : ''),
            }));
          });
          host.appendChild(rt);
        }

        function recentSection() {
          var feed = (d.feed || []).slice(0, 6);
          if (!feed.length) return;
          cap(host, 'Recent');
          var FEED_ICON = { posted: 'icon-outgoing', finished: 'icon-success', accepted: 'icon-success',
            refused: 'icon-blocked', credit: 'icon-send-alpha' };
          var ft = H.resultTable();
          ft.classList.add('list-short');
          feed.forEach(function (f) {
            ft.appendChild(H.resultRow({
              icon: FEED_ICON[f.kind] || 'icon-info',
              title: String(f.text || ''),
              subtitle: f.at_ms ? H.ago(f.at_ms) + ' ago' : '',
            }));
          });
          host.appendChild(ft);
        }

        function doorsSection() {
          cap(host, links.length ? 'Contribute more' : 'Contribute');
          var pick = H.el('div', 'tm-doors-row');
          host.appendChild(pick);
          // One button, one call. Scope, role and switching the loop on all
          // follow from "I want to help my guild" and are done for you.
          // Helping signs nothing: computing a proof needs no rights. Letting
          // the guild finish YOUR work is the separate door on the link.
          pick.appendChild(armed({
            label: 'My guild',
            confirm: d.guild_id ? 'Contribute to ' + d.guild_id + '?' : 'You are not in a guild',
            enabled: !!d.guild_id,
            run: function () { return invoke('crew_help_guild', { openMyWork: false }); },
            after: refresh,
          }));
          var friendBox = H.el('div');
          pick.appendChild(armed({
            label: 'A friend',
            toggle: function () {
              friendBox.hidden = !friendBox.hidden;
              PICKER_OPEN[ctx.id] = !friendBox.hidden;
              if (!friendBox.hidden) friendPicker(friendBox, ctx, refresh);
            },
          }));
          friendBox.hidden = true;
          host.appendChild(friendBox);
        }

        function linkedSection() {
          if (!links.length) return;
          cap(host, 'Synchronized');
          links.forEach(function (l) {
            var guild = l.kind === 'guild';
            if (l.kind === 'anyone') {
              // Terms for whoever helps: a rate or none, a door to set it,
              // and a way to stop. Nothing to open, nothing to grant.
              var doors = H.el('div', 'tm-doors-row');
              var setRate = H.el('a', 'sui-screen-btn sui-mod-primary');
              setRate.href = 'javascript:void(0)';
              setRate.appendChild(H.el('span', null, l.pay_enabled && l.rate ? 'Terms' : 'Set a rate'));
              setRate.addEventListener('click', function () { T.add('crewpay', { room: l.crew_id }); });
              doors.appendChild(setRate);
              doors.appendChild(armed({
                label: 'Stop',
                destructive: true,
                confirm: 'Stop paying pherals?',
                run: function () { return invoke('crew_stop', { crewId: l.crew_id }); },
                after: refresh,
              }));
              host.appendChild(H.resultRow({
                icon: 'icon-send-alpha',
                title: 'Any pheral',
                subtitle: l.pay_enabled && l.rate ? amt(l.rate, l.denom || 'ualpha') + ' per difficulty' : 'not paying',
                chips: [H.statTile('paying', l.pay_enabled ? 'on' : 'off', null, l.pay_enabled ? 'live' : 'muted')],
                action: doors,
              }));
              return;
            }
            var chips = guild
              ? [H.statTile('my proxies', l.open_to_guild ? 'rank ≤ ' + l.open_to_guild : 'none', null, l.open_to_guild ? 'ok' : 'muted')]
              : [authChip('my proxy', l.they_can_help_me),
                 authChip('their proxy', l.i_can_help_them)];
            // Opening your work is the one thing here that signs a
            // transaction, so it is its own armed button and never a side
            // effect of helping. A guild opens by rank; a person by grant.
            var opened = guild ? !!l.open_to_guild : l.they_can_help_me === 'granted';
            var openDoor = armed({
              label: opened ? 'Revoke proxy' : 'Make them my proxy',
              destructive: opened,
              confirm: opened
                ? (guild ? 'Revoke the guild as your proxy?' : 'Revoke ' + (l.name || l.subject) + ' as your proxy?')
                : (guild ? 'Make anyone in ' + l.subject + ' your proxy?' : 'Make ' + (l.name || l.subject) + ' your proxy?'),
              run: function () {
                if (guild) return invoke(opened ? 'crew_close_guild' : 'crew_open_guild',
                  { guildId: l.subject, rank: 101, roomId: l.crew_id });
                return invoke(opened ? 'crew_revoke' : 'crew_grant',
                  { helperPlayerId: l.subject, roomId: l.crew_id });
              },
              after: refresh,
            });
            var pc = PC();
            var row = H.el('div', 'tm-doors-row');
            row.appendChild(openDoor);
            row.appendChild(armed({
              label: 'Stop',
              destructive: true,
              confirm: 'Stop contributing, and leave?',
              run: function () { return invoke('crew_stop', { crewId: l.crew_id }); },
              after: refresh,
            }));
            host.appendChild(H.resultRow({
              portrait: guild || !pc ? null : pc.portrait(null),
              icon: guild ? 'icon-guild' : (pc ? null : 'icon-member'),
              title: String(l.name || l.subject),
              subtitle: guild ? 'your whole guild' : String(l.subject),
              chips: chips,
              action: row,
            }));
          });
        }

        if (!links.length) {
          doorsSection(); busSection(); ratesSection(); recentSection();
        } else {
          stateSection(); busSection(); linkedSection(); ratesSection(); recentSection(); doorsSection();
        }
      }).catch(function (e) { fail(host, 'crew', e); });
    },
  });

  function denomLabel(denom) {
    var d = String(denom || '');
    return d === 'ualpha' ? 'Alpha' : d.indexOf('uguild.') === 0 ? 'Guild token' : d;
  }
  function amt(base, denom) {
    var n = Number(base) || 0;
    var U = window.StructsUnits;
    if (String(denom || 'ualpha') === 'ualpha' && U) return U.fmtAlpha(n);
    return H.fmtInt(n) + ' ' + denomLabel(denom);
  }
  function plural(n, one) { return H.fmtInt(n) + ' ' + one + (Number(n) === 1 ? '' : 's'); }

  function shortRoom(id) {
    var s = String(id || '');
    var cut = s.indexOf(':');
    return (cut > 0 ? s.slice(0, cut) : s).replace(/^!/, '');
  }

  /* A button that asks before it acts, in place.
   *
   * Deliberately NOT `confirmModal`: a full-screen scrim for "open your work
   * to your guild" is heavier than the decision, and the modal did not appear
   * at all when the crew card was driven in its own popped-out window
   * (reproduced three times against the running app, 2026-09-11; the same
   * click opens it in the jsdom harness, so the cause is the window, not this
   * code). An inline second click needs no overlay to be right.
   */
  function armed(spec) {
    var a = H.el('a', 'sui-screen-btn ' + (spec.destructive ? 'sui-mod-destructive' : 'sui-mod-primary'));
    a.href = 'javascript:void(0)';
    var label = H.el('span', null, spec.label);
    a.appendChild(label);
    if (spec.enabled === false) {
      a.classList.add('is-disabled');
      a.title = spec.confirm || '';
      return a;
    }
    var armedNow = false, timer = null;
    function disarm() {
      armedNow = false;
      label.textContent = spec.label;
      a.classList.remove('sui-mod-destructive');
      if (spec.destructive) a.classList.add('sui-mod-destructive');
      if (timer) { clearTimeout(timer); timer = null; }
    }
    a.addEventListener('click', function () {
      if (spec.toggle) { spec.toggle(); return; }
      if (!armedNow) {
        armedNow = true;
        label.textContent = spec.confirm || 'Sure?';
        // Arming that never expires is a button that stays a trap. Half a
        // minute is long enough to read it and short enough to forget safely.
        timer = setTimeout(disarm, 30000);
        return;
      }
      disarm();
      label.textContent = 'Working…';
      spec.run()
        .then(function () { if (spec.after) spec.after(); })
        .catch(function (e) { label.textContent = String(e); });
    });
    return a;
  }

  /* Choosing a person. The same search the Pay card uses, because "who" is
   * the same question here and a second way to answer it is a second thing to
   * learn. */
  function friendPicker(box, ctx, refresh) {
    box.innerHTML = '';
    var input = H.textBox('', 'name or 1-61');
    var results = H.el('div');
    box.appendChild(H.field('Who', input));
    box.appendChild(results);
    var timer = null;
    function search() {
      var q = String(T.readControl(input) || '').trim();
      if (q.length < 2) { results.innerHTML = ''; return; }
      // A whole id needs no search: it IS the answer.
      if (/^1-\d+$/.test(q)) { show([{ player_id: q, name: q }]); return; }
      invoke('mcp_player_search', { query: q })
        .then(function (r) { show((r && (r.players || r.results)) || []); })
        .catch(function (e) { results.innerHTML = ''; results.appendChild(H.alertLine(String(e), 'icon-alert')); });
    }
    function show(rows) {
      results.innerHTML = '';
      rows.slice(0, 6).forEach(function (r) {
        var pc = PC();
        results.appendChild(H.resultRow({
          portrait: pc ? pc.portrait(r.pfp || r.pfp_attrs) : null,
          icon: pc ? null : 'icon-member',
          title: String(r.name || r.player_id), subtitle: String(r.player_id),
          action: armed({
            label: 'Contribute',
            confirm: 'Contribute to ' + (r.name || r.player_id) + '?',
            run: function () { return invoke('crew_help_player', { playerId: r.player_id, openMyWork: false }); },
            after: refresh || function () { T.refresh(ctx.id, true); },
          }),
        }));
      });
    }
    input.addEventListener('input', function () {
      if (timer) clearTimeout(timer);
      timer = setTimeout(search, 250);
    });
  }

  // ── CREW PAY ──────────────────────────────────────────────────────────
  //
  // What the crew has earned and what it has been paid. The ledger is written
  // from the chain's own `EventHashSuccess` receipts, never from a message, so
  // every row here names a transaction that can be looked up.
  T.register('crewpay', {
    label: 'Bounty',
    describe: function (p) { return 'Bounty' + (p && p.room ? ' · ' + shortRoom(p.room) : ''); },
    cadenceMs: 30000,
    params: [{ key: 'room', label: 'Cluster', kind: 'text', placeholder: 'helpers' }],
    render: function (host, p, ctx) {
      return invoke('crew_list').then(function (d) {
        var crews = (d && d.crews) || [];
        host.innerHTML = '';
        /* One door, for the ordinary case: the people finishing your work
         * over the bus are not linked to you at all, so no crew's terms
         * cover them. "Anyone who helps" is a terms-only crew — it grinds
         * for nobody — and it appears here like any other once made. */
        if (!crews.some(function (c) { return c.scope === 'anyone'; })) {
          var doors = H.el('div', 'tm-doors-row');
          doors.appendChild(armed({
            label: 'Pay pherals',
            confirm: 'Set what pherals are paid?',
            run: function () { return invoke('crew_pay_anyone', {}); },
            after: function () { T.setParams(ctx.id, { room: 'helpers' }); T.refresh(ctx.id, true); },
          }));
          host.appendChild(doors);
        }
        if (!crews.length) return;
        var room = (p && p.room) || crews[0].room_id;
        var crew = crews.filter(function (c) { return c.room_id === room; })[0] || crews[0];
        room = crew.room_id;
        if (crews.length > 1) {
          host.appendChild(H.navStrip(crews.map(function (c) {
            return { key: c.room_id, label: c.name || shortRoom(c.room_id) };
          }), room, function (k) { T.setParams(ctx.id, { room: k }); }));
        }
        return invoke('crew_ledger', { roomId: room }).then(function (l) {
          var pay = crew.pay || {};
          var plan = (l && l.plan) || [];
          var due = plan.reduce(function (n, s) { return n + (s.amount_base || 0); }, 0);
          var den = pay.denom || 'ualpha';
          host.appendChild(tiles([
            [['rate', denomLabel(den)], pay.rate_per_difficulty
              ? amt(pay.rate_per_difficulty, den) + ' / difficulty' : 'unset',
              null, pay.rate_per_difficulty ? null : 'muted'],
            ['owed', amt(l.owed_base || 0, den)],
            ['this epoch', amt(l.spent_this_epoch || 0, den)
              + (pay.epoch_cap ? ' / ' + amt(pay.epoch_cap, den) : '')],
            ['due now', amt(due, den), null, due ? 'live' : 'muted'],
            ['pays from', pay.min_payout ? amt(pay.min_payout, den) : 'any amount', null, pay.min_payout ? null : 'muted'],
          ]));

          host.appendChild(H.field('Pay automatically', H.checkbox(!!pay.enabled, null, function (on) {
            crew.pay = Object.assign({}, pay, { enabled: on });
            invoke('crew_save', { crew: crew }).then(function () { T.refresh(ctx.id, true); })
              .catch(function (e) { Board.stamp && Board.stamp('crew: ' + e); });
          })));
          host.appendChild(ticket({
            cta: 'Save terms',
            fields: [
              { key: 'denom', label: 'Token', kind: 'choice', value: pay.denom || 'ualpha', options: [
                { value: 'ualpha', label: 'Alpha' },
              ].concat(d.guild_id ? [{ value: 'uguild.' + d.guild_id, label: 'Guild token' }] : []) },
              { key: 'rate', label: 'Per difficulty', kind: 'amount', value: String(pay.rate_per_difficulty || 0) },
              { key: 'per_helper_cap', label: 'Cap per helper', kind: 'amount', value: String(pay.per_helper_cap || 0) },
              { key: 'epoch_cap', label: 'Cap per epoch', kind: 'amount', value: String(pay.epoch_cap || 0) },
              // Batching: a helper is paid once they are owed this much, so a
              // busy crew settles in a few transactions, not one per proof.
              { key: 'min_payout', label: 'Pay once owed', kind: 'amount', value: String(pay.min_payout || 0) },
            ],
            confirm: function (v) {
              return { title: 'Set the cluster’s terms?', cta: 'Save', rows: [
                ['Token', String(v.denom)],
                ['Rate', String(v.rate || 0) + ' per difficulty'],
                ['Per helper', Number(v.per_helper_cap) ? String(v.per_helper_cap) : 'no cap'],
                ['Per epoch', Number(v.epoch_cap) ? String(v.epoch_cap) : 'no cap'],
                ['Pay once owed', Number(v.min_payout) ? String(v.min_payout) : 'any amount'],
              ] };
            },
            submit: function (v) {
              crew.pay = { enabled: !!pay.enabled, denom: String(v.denom || 'ualpha'),
                rate_per_difficulty: Number(v.rate) || 0, epoch_secs: pay.epoch_secs || 3600,
                epoch_cap: Number(v.epoch_cap) || 0, per_helper_cap: Number(v.per_helper_cap) || 0,
                min_payout: Number(v.min_payout) || 0 };
              return invoke('crew_save', { crew: crew });
            },
            done: function () { T.refresh(ctx.id, true); },
          }));

          plan.forEach(function (s) {
            host.appendChild(H.resultRow({
              icon: 'icon-send-alpha', title: String(s.helper_player),
              subtitle: amt(s.amount_base, s.denom) + ' · ' + plural(s.credit_ids.length, 'proof'),
              chips: s.capped ? [H.statTile('capped', 'yes', null, 'bad')] : [],
            }));
          });
          if (due > 0) {
            host.appendChild(doorRow([{ label: 'Pay now', primary: true, onClick: function (a) {
              a.textContent = '…';
              invoke('crew_settle', { roomId: room })
                .then(function () { T.refresh(ctx.id, true); })
                .catch(function (e) { a.textContent = String(e); });
            } }]));
          }

          cap(host, 'Receipts');
          var rows = (l.credits || []).slice().sort(function (a, b) { return b.ts_ms - a.ts_ms; }).slice(0, 20);
          if (!rows.length) { host.appendChild(H.stateBlock('info', 'Nobody has finished anything for you yet.')); return; }
          rows.forEach(function (c) {
            host.appendChild(H.resultRow({
              icon: c.category === 'refine' ? 'icon-refine' : 'icon-mine',
              title: String(c.helper_player) + ' · ' + c.object_id,
              subtitle: String(c.category) + ' · difficulty ' + c.difficulty,
              chips: [
                H.statTile('owed', amt(c.amount_base, c.denom)),
                H.statTile('paid', c.settled_at ? 'yes' : 'no', null, c.settled_at ? 'ok' : 'muted'),
              ],
            }));
          });
        });
      }).catch(function (e) { fail(host, 'crew pay', e); });
    },
  });

  T.register('pow', {
    label: 'Proof queue', describe: function () { return 'Proof queue'; }, cadenceMs: 5000,
    render: function (host, p, ctx) {
      return invoke('mcp_work').then(function (d) {
        host.innerHTML = '';
        var c = d.counts || {}, hc = d.hash_config || {};
        /* `done` was a tile that read 0 forever: a completed task reaps
         * itself, so the count it showed was of tasks caught mid-reap.
         * `running` is nearly as quiet — a GPU solve is tens of
         * milliseconds, so a poll almost never lands on one. What actually
         * says the engine is working is how much it has SOLVED, which the
         * same payload already carries. Live 2026-09-07: 0 running, 0 done,
         * 1,657 waiting, and 161 solves in the hour. */
        var solved = (Array.isArray(d.pow_stats) ? d.pow_stats : []).reduce(function (n, e) { return n + (e.solves || 0); }, 0);
        host.appendChild(tiles([
          ['running', H.fmtInt(c.running || 0), null, c.running ? 'live' : 'muted'],
          ['waiting', H.fmtInt(c.waiting || 0), null, (c.waiting || 0) > (hc.max_concurrent || 0) * 4 ? 'bad' : null],
          [['solved', '24h'], H.fmtInt(solved), null, solved ? 'ok' : 'bad'],
        ]));
        // Engine, difficulty and concurrency are three short facts, not three
        // sentences: as label/value rows they wrapped in a one-wide card.
        host.appendChild(tiles([
          [['difficulty', hc.auto_tune ? 'auto-tuned' : 'fixed'], hc.difficulty_start == null ? '—' : String(hc.difficulty_start), null,
            hc.difficulty_start != null && hc.difficulty_start > 32 ? 'bad' : null],
          ['concurrent', hc.max_concurrent == null ? '—' : String(hc.max_concurrent)],
          ['engine', String(hc.effective_engine || '?').toUpperCase(), null, hc.gpu_available ? 'ok' : 'muted'],
        ]));
        if (d.error) host.appendChild(H.alertLine(String(d.error), 'icon-alert'));
        // Hashing is the one engine a player may want to stop dead — a laptop
        // on battery, a machine needed for something else.
        var on = hc.enabled !== false;
        host.appendChild(doorRow([{ label: on ? 'Pause hashing' : 'Resume hashing', primary: !on, onClick: function () {
          invoke('mcp_config_set', { domain: 'hash', payload: { enabled: !on } })
            .then(function () { T.refresh(ctx.id, true); })
            .catch(function (e) { Board.stamp && Board.stamp('hash: ' + e); });
        } }]));
      }).catch(function (e) { fail(host, 'work', e); });
    },
  });
  T.register('solve', {
    label: 'Solve rate', describe: function () { return 'Solve rate · 24h'; }, cadenceMs: 30000,
    render: function (host) {
      return invoke('mcp_work').then(function (d) {
        host.innerHTML = '';
        var pow = d.pow_stats;
        if (pow && pow.error) { host.appendChild(H.stateBlock('error', 'solve stats unavailable: ' + pow.error)); return; }
        var engines = (Array.isArray(pow) ? pow : []).slice().sort(function (a, b) { return (b.solves || 0) - (a.solves || 0); });
        if (!engines.length) { host.appendChild(H.stateBlock('info', 'No solves in the last 24h.')); return; }
        engines.forEach(function (e) {
          var few = e.p90_duration_ms == null;
          host.appendChild(H.resultRow({
            icon: 'icon-computer', title: String(e.engine || '?').toUpperCase(), subtitle: H.fmtInt(e.solves) + ' solves',
            chips: [
              H.statTile('median', H.duration((e.median_duration_ms || 0) / 1000)),
              few ? null : H.statTile('p90', H.duration(e.p90_duration_ms / 1000)),
              // A difficulty alone says little; which way it is MOVING decides
              // whether the engine is keeping up with the chain.
              H.statTile('difficulty', e.median_difficulty == null ? '—' : String(e.median_difficulty)
                + (e.median_difficulty_prev == null ? '' : (e.median_difficulty > e.median_difficulty_prev ? ' ↑' : e.median_difficulty < e.median_difficulty_prev ? ' ↓' : '')),
                null, e.median_difficulty_prev == null ? null : (e.median_difficulty > e.median_difficulty_prev ? 'bad' : e.median_difficulty < e.median_difficulty_prev ? 'ok' : '')),
              H.statTile('hashrate', e.est_hashrate_hps == null ? '—' : H.fmtNum(e.est_hashrate_hps) + 'H/s', null, e.est_hashrate_hps == null ? 'muted' : ''),
            ].filter(Boolean),
          }));
        });
      }).catch(function (e) { fail(host, 'work', e); });
    },
  });
  T.register('tasks', {
    label: 'Proof tasks', defaultWidth: 2,
    describe: function (p) { return 'Proof tasks' + (p.type ? ' · ' + p.type : '') + (p.status ? ' · ' + p.status : ''); },
    params: [
      { key: 'type', label: 'Type', kind: 'choice', options: [{ value: '', label: 'all types' }, { value: 'MINE', label: 'Mine' }, { value: 'REFINE', label: 'Refine' }, { value: 'BUILD', label: 'Build' }, { value: 'RAID', label: 'Raid' }] },
      { key: 'status', label: 'Status', kind: 'choice', options: [{ value: '', label: 'any status' }, { value: 'running', label: 'running' }, { value: 'waiting', label: 'waiting' }, { value: 'completed', label: 'completed' }] },
    ],
    cadenceMs: 5000,
    render: function (host, p, ctx) {
      return invoke('mcp_work').then(function (d) {
        host.innerHTML = '';
        var all = (d.tasks || []).filter(function (t) {
          if (p.type && t.task_type !== p.type) return false;
          if (p.status && String(t.status) !== p.status) return false;
          return true;
        });
        // Finished proofs are history, not a queue: out of the way unless
        // asked for, and the caption says how many were set aside.
        var done = p.status ? 0 : all.filter(function (t) { return String(t.status) === 'completed'; }).length;
        var rows = p.status ? all : all.filter(function (t) { return String(t.status) !== 'completed'; });
        // Running first (most advanced at the top), then waiting, then done.
        var ORDER = { running: 0, waiting: 1, completed: 2 };
        rows.sort(function (a, b) {
          var sa = ORDER[a.status] == null ? 1 : ORDER[a.status], sb = ORDER[b.status] == null ? 1 : ORDER[b.status];
          return sa !== sb ? sa - sb : pct(b.percent_complete) - pct(a.percent_complete);
        });
        cap(host, rows.length + ' task' + (rows.length === 1 ? '' : 's')
          + (rows.length > 25 ? ' · showing 25 of ' + rows.length : '')
          + (done ? ' · ' + done + ' finished hidden' : ''));
        if (!rows.length) { host.appendChild(H.stateBlock('info', 'Nothing in the queue.')); return; }
        // One task row from the catalogue (structs-cards.js): the struct's
        // art or the task glyph, the id, progress, difficulty of 64, the eta.
        var table = H.resultTable();
        rows.slice(0, 25).forEach(function (t) {
          table.appendChild(window.StructsCards.task.row({
            id: t.task_id || '?', type: t.task_type, status: String(t.status || 'waiting'),
            frac: pct(t.percent_complete) / 100, difficulty: t.current_difficulty, eta: t.eta,
            structType: t.struct_type_name || t.struct_type || null,
          }, {
            onClick: t.task_id ? function () { add('inspector', { id: String(t.task_id).split(':')[0] }); } : null,
            doors: String(t.status) === 'completed' ? [] : [
              { icon: 'icon-close', title: 'Cancel this proof', destructive: true, onClick: function () {
                invoke('stop_hash_task', { pid: t.task_id }).then(function () { T.refresh(ctx.id, true); })
                  .catch(function (e) { Board.stamp && Board.stamp('cancel: ' + e); });
              } },
            ],
          }));
        });
        host.appendChild(table);
      }).catch(function (e) { fail(host, 'work', e); });
    },
  });

  // ── Signing (mcp_tx_snapshot / mcp_tx_mutate) ────────────────────────────
  // One transaction row from the catalogue (structs-cards.js): rank, type,
  // signer, charge and attempts; the countdown in blocks; move and cancel as
  // doors. In flight has no doors.
  function txRow(t, pos, total, q, state, mutate) {
    var eta = q && q.etas && q.etas[t.id];
    var pctv = q && q.percents && q.percents[t.id];
    var doors = [];
    if (mutate && state === 'queued' && pos != null) {
      if (pos > 1) doors.push({ icon: 'icon-caret-up', title: 'Move up', onClick: function () { mutate('move_up', t.id); } });
      if (pos < total) doors.push({ icon: 'icon-caret-down', title: 'Move down', onClick: function () { mutate('move_down', t.id); } });
    }
    if (mutate && state !== 'flight') doors.push({ icon: 'icon-close', title: 'Cancel', destructive: true, onClick: function () { mutate('cancel', t.id); } });
    return window.StructsCards.tx.row({
      id: t.id, type: t.type_short || t.type_url || '?', signer: t.player_id || t.signer || null, position: pos,
      charge: t.charge_cost > 0 ? t.charge_cost : null, attempts: t.attempts, retryLimit: t.retry_limit, state: state,
      eta: eta && eta.blocksRemaining != null
        ? { text: eta.blocksRemaining + ' blk', frac: pctv != null ? pctv / 100 : 0, title: '~' + Math.max(0, Math.round((eta.etaMs || 0) / 1000)) + 's' }
        : (pctv != null ? { text: '', frac: pctv / 100 } : null),
    }, { doors: doors });
  }
  T.register('queue', {
    label: 'Signing queue',
    describe: function (p) { return 'Signing queue' + (p.signer ? ' · ' + p.signer : ''); },
    params: [{ key: 'signer', label: 'Signer', kind: 'id', kinds: [1], placeholder: 'any player' }],
    cadenceMs: 2500,
    render: function (host, p, ctx) {
      return invoke('mcp_tx_snapshot').then(function (d) {
        host.innerHTML = '';
        var q = d && d.queue;
        if (!q) { host.appendChild(H.alertLine('signing queue unavailable — sign in on the game window' + (d && d.queue_error ? ' (' + d.queue_error + ')' : ''), 'icon-alert')); return; }
        var mine = function (t) { return !p.signer || String(t.player_id || t.signer || '') === p.signer; };
        var aq = (q.action_queue || []).filter(mine), iq = (q.immediate_queue || []).filter(mine);
        host.appendChild(tiles([
          ['in flight', q.in_flight ? '1' : '0', null, q.in_flight ? 'live' : 'muted'],
          ['queued', H.fmtInt(aq.length), null, aq.length ? null : 'muted'],
          ['immediate', H.fmtInt(iq.length), null, iq.length ? 'live' : 'muted'],
        ]));
        var mutate = function (op, id) {
          invoke('mcp_tx_mutate', { op: op, id: id, newIndex: null }).then(function (r) {
            if (r && r.ok === false) Board.stamp && Board.stamp('refused — item is in flight or already gone');
            T.refresh(ctx.id, true);
          }).catch(function (e) { Board.stamp && Board.stamp('tx: ' + e); });
        };
        var table = H.resultTable();
        if (q.in_flight && mine(q.in_flight)) table.appendChild(txRow(q.in_flight, null, 0, null, 'flight', null));
        iq.forEach(function (t) { table.appendChild(txRow(t, null, 0, null, 'immediate', mutate)); });
        aq.forEach(function (t, i) { table.appendChild(txRow(t, i + 1, aq.length, q, 'queued', mutate)); });
        host.appendChild(table);
        /* An empty queue and a dead one look identical — three zeroes and a
         * line of grey text — and the queue drains between polls all day. The
         * last result is in the same snapshot, so say when signing last
         * happened rather than leaving the card to be read as broken. */
        if (!q.in_flight && !aq.length && !iq.length) {
          var last = ((d && d.history) || []).filter(function (h) { return !p.signer || String(h.player_id || h.context || '') === p.signer; })[0];
          host.appendChild(H.el('div', 'ops-muted', 'nothing waiting to sign' +
            (last ? ' · last signed ' + H.ago(last.ts_ms) + ' ago' : '')));
        }
      }).catch(function (e) { fail(host, 'tx', e); });
    },
  });
  T.register('results', {
    label: 'Tx results',
    describe: function (p) { return 'Tx results' + (p.outcome ? ' · ' + p.outcome : ''); },
    params: [
      { key: 'outcome', label: 'Outcome', kind: 'choice', options: [{ value: '', label: 'all' }, { value: 'success', label: 'success' }, { value: 'failed', label: 'failed' }, { value: 'skipped', label: 'skipped' }] },
      // On an 800-player roster one player's failures are invisible in a
      // shared list; this is how you ask about that player. (There is no
      // retry door: the queue has no retry op, and a history row keeps the
      // message type and the error but not the arguments, so there is nothing
      // to replay — you redo the action from the card that owns it.)
      { key: 'signer', label: 'Signer', kind: 'id', kinds: [1], placeholder: 'any player' },
    ],
    cadenceMs: 10000,
    render: function (host, p) {
      return invoke('mcp_tx_snapshot').then(function (d) {
        host.innerHTML = '';
        if (d && d.history_error) { host.appendChild(H.stateBlock('error', 'history unavailable: ' + d.history_error)); return; }
        var hist = (d && d.history) || [];
        var n = { success: 0, failed: 0, skipped: 0 };
        hist.forEach(function (h) { if (n[h.outcome] != null) n[h.outcome]++; else n.failed++; });
        host.appendChild(tiles([
          ['ok', H.fmtInt(n.success), null, 'ok'],
          ['failed', H.fmtInt(n.failed), null, n.failed ? 'bad' : 'muted'],
          ['skipped', H.fmtInt(n.skipped), null, 'muted'],
        ]));
        var rows = hist.filter(function (h) {
          if (p.outcome && !(p.outcome === 'failed' ? (h.outcome !== 'success' && h.outcome !== 'skipped') : h.outcome === p.outcome)) return false;
          if (p.signer && String(h.player_id || h.context || '') !== p.signer) return false;
          return true;
        });
        if (!rows.length) { host.appendChild(H.stateBlock('info', 'No recent transactions.')); return; }
        if (rows.length > 25) cap(host, 'showing 25 of ' + rows.length);
        var table = H.resultTable();
        rows.slice(0, 25).forEach(function (h) {
          var ok = h.outcome === 'success';
          var err = ok ? null : String(h.translated || h.raw_error || '').replace(/^failed to execute message; message index: \d+: /, '');
          table.appendChild(window.StructsCards.tx.row({
            id: h.id, type: String(h.action || '').replace(/^.*Msg/, '') || '?', signer: h.player_id || h.context || null,
            state: ok ? 'ok' : h.outcome === 'skipped' ? 'skipped' : 'failed', hash: h.tx_hash || null, ago: H.ago(h.ts_ms), error: err, attempts: h.attempts,
          }, { doors: h.tx_hash ? [{ icon: 'icon-copy', title: 'Copy the hash', onClick: function () { if (navigator.clipboard) navigator.clipboard.writeText(String(h.tx_hash)).catch(function () {}); } }] : [] }));
        });
        host.appendChild(table);
      }).catch(function (e) { fail(host, 'tx', e); });
    },
  });

  /* The one-object history card is the chart card now (board-terminal-chart.js);
   * a layout that saved a `series` card opens as a one-series chart. */

  /* ── A guild's people ────────────────────────────────────────────────────
   *
   * The guild card answers "how big is it". That is a statistic, not a
   * community. The questions a guild turns on are about PEOPLE: who is in it,
   * who is still playing, who has gone quiet, who can be reached — and every
   * row here carries the two doors that reach them, plus where we stand.
   *
   * Liveness is the block each player last acted on, so "quiet" is a fact
   * rather than an impression. A member we have never seen act says so
   * instead of being sorted as if they were the quietest.
   */
  T.register('members', {
    label: 'Guild members', defaultWidth: 2,
    describe: function (p) { return 'Members · ' + (p.id || '?'); },
    params: [{ key: 'id', label: 'Guild', kind: 'id', kinds: [0], placeholder: '0-1' }],
    cadenceMs: 120000,
    render: function (host, p) {
      if (!p.id) { host.innerHTML = ''; host.appendChild(H.stateBlock('info', 'Configure this card with a guild id.')); return; }
      return Promise.all([invoke('terminal_guild_members', { guildId: p.id }), T.standingLists()]).then(function (res) {
        var d = res[0] || {}, lists = res[1];
        host.innerHTML = '';
        var all = d.members || [];
        // 5.28s a block: a day is ~16,364 blocks.
        var DAY = 16364;
        var live = all.filter(function (m) { return m.quiet_blocks != null && m.quiet_blocks < DAY; });
        var never = all.filter(function (m) { return m.quiet_blocks == null; });
        host.appendChild(tiles([
          ['members', H.fmtInt(d.count || all.length)],
          [['acted', 'in the last day'], H.fmtInt(live.length), null, live.length ? 'ok' : 'muted'],
          [['never seen', 'acting'], H.fmtInt(never.length), null, never.length ? 'muted' : 'ok'],
        ]));
        if (!all.length) { host.appendChild(H.stateBlock('info', 'No roster published for ' + p.id + '.')); return; }
        if (all.length > 30) cap(host, 'showing 30 of ' + all.length + ' · quietest last');
        var table = H.resultTable();
        all.slice(0, 30).forEach(function (m) {
          // The guild is this card's subject, so only standings about the
          // PERSON belong on their row.
          var stand = T.standingOf(lists, m.player_id, p.id, { personOnly: true });
          table.appendChild(window.StructsPlayerCard.row({
            id: m.player_id, name: m.name || m.player_id, pfp: m.pfp,
            presence: Board.presenceDot && Board.presenceDot(m.player_id),
            badge: stand ? stand.badge : null,
            sub: m.quiet_blocks == null ? 'never seen acting'
              : 'quiet ' + window.StructsUnits.fmtDuration(Math.round(m.quiet_blocks * 5.28)),
            attn: stand ? stand.note : null,
          }, {
            onClick: function () { add('player', { id: m.player_id }); },
            actions: Board.reachActions ? Board.reachActions({ player_id: m.player_id, player_name: m.name }) : [],
          }));
        });
        host.appendChild(table);
      }).catch(function (e) { fail(host, 'members', e); });
    },
  });

  /* ── BUILD: the last verb with no way in ─────────────────────────────────
   *
   * `build` takes a struct type, an ambit and a SLOT — and a slot number is
   * not something a person knows. Offered as a bare number it is a guess the
   * chain refuses, which is why the placement verbs were the last two the
   * Terminal could not reach. `terminal_build_slots` subtracts the occupied
   * slots from the planet's own per-ambit count, so what is offered is what
   * is free.
   *
   * The type list is the chain's (`mcp_struct_type_catalog`), filtered to
   * what can stand on a planet, and each carries its build charge — the cost
   * you are about to spend, named before you spend it.
   */
  var AMBIT_ORDER = ['space', 'air', 'land', 'water'];
  T.register('build', {
    label: 'Build a struct', defaultWidth: 1,
    describe: function (p) { return 'Build on ' + (p.id || '?'); },
    params: [{ key: 'id', label: 'Planet', kind: 'id', kinds: [2], placeholder: '2-15361' }],
    cadenceMs: 60000,
    render: function (host, p, ctx) {
      if (!p.id) { host.innerHTML = ''; host.appendChild(H.stateBlock('info', 'Configure this card with a planet id.')); return; }
      return Promise.all([
        invoke('terminal_build_slots', { planet: p.id }),
        invoke('terminal_struct_types').catch(function () { return []; }),
      ]).then(function (res) {
        var d = res[0] || {}, types = res[1] || [];
        host.innerHTML = '';
        var ambits = d.ambits || {};
        var freeAll = AMBIT_ORDER.reduce(function (n, a) { return n + (((ambits[a] || {}).free || []).length); }, 0);
        host.appendChild(tiles([
          ['planet', String(d.planet_id || p.id)],
          [['free slots', 'across every ambit'], H.fmtInt(freeAll), null, freeAll ? 'ok' : 'bad'],
          ['owner', String(d.owner || '—')],
        ]));
        // Which ambits have room, read across in the same order every time.
        var row = H.el('div', 'tm-ambits');
        row.appendChild(H.el('span', 'fstat-l', 'free'));
        AMBIT_ORDER.forEach(function (a) {
          var f = ((ambits[a] || {}).free || []).length, n = (ambits[a] || {}).slots || 0;
          var chip = H.el('span', 'tm-ambit' + (f ? ' is-on sc-ok' : ''));
          chip.textContent = a + ' ' + f + '/' + n;
          chip.title = f ? f + ' of ' + n + ' slots open' : 'full';
          row.appendChild(chip);
        });
        host.appendChild(row);
        if (!freeAll) { host.appendChild(H.stateBlock('info', 'Every slot on ' + (d.planet_id || p.id) + ' is taken.')); return; }
        var planetary = types.filter(function (t) { return String(t.category || '').toLowerCase() === 'planet'; });
        if (!planetary.length) planetary = types;
        var slot = H.el('div', 'tm-ticket-slot');
        host.appendChild(doorRow([{ label: 'Build', primary: true, onClick: function () {
          slot.innerHTML = '';
          slot.appendChild(ticket({
            cta: 'Build',
            // The slot choices FOLLOW the ambit: a slot number means nothing
            // without one, and offering a full ambit's numbers is offering a
            // refusal.
            fields: function (v) {
              var a = v.ambit || AMBIT_ORDER.filter(function (x) { return ((ambits[x] || {}).free || []).length; })[0];
              var free = (ambits[a] || {}).free || [];
              return [
                { key: 'struct_type', label: 'Type', kind: 'choice', value: v.struct_type,
                  options: planetary.map(function (t) { return { value: t.name, label: t.name + (t.build_charge ? ' · ' + t.build_charge + ' charge' : '') }; }) },
                { key: 'ambit', label: 'Ambit', kind: 'choice', value: a,
                  options: AMBIT_ORDER.filter(function (x) { return ((ambits[x] || {}).free || []).length; })
                    .map(function (x) { return { value: x, label: x }; }) },
                { key: 'slot', label: 'Slot', kind: 'choice', value: v.slot,
                  options: free.map(function (i) { return { value: String(i), label: 'slot ' + i }; }) },
              ];
            },
            confirm: function (v) {
              var t = planetary.filter(function (x) { return x.name === v.struct_type; })[0];
              return { title: 'Build a ' + (v.struct_type || '?') + '?', cta: 'Build', rows: [
                ['Planet', String(d.planet_id || p.id)],
                ['Where', (v.ambit || '?') + ' · slot ' + (v.slot == null ? '?' : v.slot)],
                ['Charge', t && t.build_charge ? String(t.build_charge) : '—'],
                ['Signing as', String(d.owner || 'primary')],
              ] };
            },
            submit: function (v) {
              if (!v.struct_type) return Promise.reject('choose a type');
              return invoke('mcp_struct_act', { player: d.owner || 'primary', action: 'build',
                args: { struct_type: v.struct_type, ambit: v.ambit, slot: Number(v.slot) || 0 } })
                .then(function (msg) { Board.stamp && Board.stamp(String(msg).split('\n')[0]); });
            },
            done: function () { T.refresh(ctx.id, true); },
          }));
        } }]));
        host.appendChild(slot);
      }).catch(function (e) { fail(host, 'build', e); });
    },
  });

  /* ── OPS: the verbs, on the struct in front of you ───────────────────────
   *
   * `mcp_action` exposes fourteen of the game's verbs — explore, mine, refine,
   * build, activate, deactivate, attack, defend, move_fleet, transfer, deploy,
   * raid, update_primary_reactor, resync — and exactly two of them had reached
   * a card: raid (from the target board) and refine (from the wallet). The
   * Terminal could see a struct sitting offline, and the only way to turn it
   * on was somewhere else.
   *
   * The verbs a struct can take depend on what it IS and what state it is in,
   * and the chain already tells us both (`matrix_refs`: built / online /
   * destroyed / type_name). So this offers only what would actually go
   * through, rather than a menu of refusals — and every one goes through the
   * ticket, so nothing is signed without a confirm that names it.
   *
   * A mine or refine cycle begins when the rig comes ONLINE (the ore clock is
   * the planet's, since v0.21.0), so `activate` is the economy's start button
   * and the explicit cycle verbs are for restarting one that has stopped.
   */
  /* Which verbs, and through WHICH command.
   *
   * Struct verbs go through `mcp_struct_act`, not `mcp_action`. Two reasons,
   * both of which matter on a roster of virtual players: it takes the acting
   * PLAYER (so a rig owned by a worker is switched on by that worker, not by
   * the primary), and it carries an allowlist of struct verbs the map offers
   * — including `defense_clear`, `stealth_*` and `build_cancel`, which
   * `mcp_action` does not expose at all. `mine` and `refine` are the two that
   * are NOT struct actions in that sense — they start a proof — so those keep
   * the `mcp_action` path.
   */
  /* Only the ambits this hull may enter AND that have a slot open. An ambit
   * it cannot occupy is not a choice, and neither is a full one. */
  function DEPLOY_OPEN(d) {
    var ambits = (d || {}).ambits || {};
    return AMBIT_ORDER.filter(function (a) {
      var x = ambits[a] || {};
      return x.allowed !== false && (x.free || []).length;
    }).map(function (a) {
      var x = ambits[a] || {};
      return { value: a, label: a + ' · ' + x.free.length + '/' + x.slots + ' open' + (x.here ? ' · here now' : '') };
    });
  }

  function structVerbs(ref) {
    if (!ref || ref.destroyed) return [];
    var name = String(ref.type_name || '');
    var mines = /Extractor|Mining/i.test(name);
    var refines = /Refinery|Refine/i.test(name);
    var out = [];
    if (!ref.built) {
      // The build proof is the hasher's; what a person can do to an unbuilt
      // struct is call it off.
      out.push({ verb: 'build_cancel', label: 'Cancel the build', danger: true, args: function () { return { struct_id: ref.id }; } });
      return out;
    }
    if (ref.online) out.push({ verb: 'deactivate', label: 'Take offline', danger: true, args: function () { return { struct_id: ref.id }; } });
    else out.push({ verb: 'activate', label: 'Bring online', args: function () { return { struct_id: ref.id }; } });
    // A cycle begins when the rig comes online; these restart one that stopped.
    if (mines && ref.online) out.push({ verb: 'mine', via: 'action', label: 'Start a mine cycle', args: function () { return { struct_id: ref.id }; } });
    if (refines && ref.online) out.push({ verb: 'refine', via: 'action', label: 'Start a refine cycle', args: function () { return { struct_id: ref.id }; } });
    out.push({
      verb: 'defend', label: 'Defend another struct',
      fields: [{ key: 'protected_id', label: 'Protect', placeholder: '5-…' }],
      args: function (v) { return { defender_id: ref.id, protected_id: v.protected_id }; },
      needs: 'protected_id',
    });
    out.push({ verb: 'defense_clear', label: 'Stop defending', args: function () { return { struct_id: ref.id }; } });
    /* Reposition — `deploy` is `struct_move`, the verb behind the reach
     * doctrine: you win by standing in an ambit the enemy neither reaches nor
     * occupies. The destination is not free-text. `prepare` reads which ambits
     * this hull may enter and which slots are open where it stands, so the
     * form offers legal moves only. */
    out.push({
      verb: 'deploy', label: 'Reposition',
      prepare: function () { return invoke('terminal_deploy_slots', { id: ref.id }); },
      fields: function (v, d) {
        var open = DEPLOY_OPEN(d);
        var a = v.ambit || (open[0] || {}).value;
        var free = ((((d || {}).ambits || {})[a]) || {}).free || [];
        return [
          { key: 'ambit', label: 'Ambit', kind: 'choice', value: a, options: open },
          { key: 'slot', label: 'Slot', kind: 'choice', value: v.slot,
            options: free.map(function (i) { return { value: String(i), label: 'slot ' + i }; }) },
        ];
      },
      rows: function (v, d) {
        return [
          ['From', (d && d.ambit ? d.ambit + ' · slot ' + d.slot : '—')],
          ['To', (v.ambit || '?') + ' · slot ' + (v.slot == null ? '?' : v.slot)],
          ['Charge', d && d.move_charge != null ? String(d.move_charge) : '—'],
        ];
      },
      args: function (v) { return { struct_id: ref.id, ambit: v.ambit, slot: Number(v.slot) || 0 }; },
      needs: 'ambit',
    });
    out.push({
      verb: 'attack', label: 'Attack', danger: true,
      fields: [
        { key: 'target_id', label: 'Target', placeholder: '5-…' },
        { key: 'weapon', label: 'Weapon', kind: 'choice', options: [{ value: 'primary', label: 'primary' }, { value: 'secondary', label: 'secondary' }] },
      ],
      args: function (v) { return { attacker_id: ref.id, target_id: v.target_id, weapon: v.weapon || 'primary' }; },
      needs: 'target_id',
    });
    return out;
  }
  T.register('ops', {
    label: 'Act on a struct', defaultWidth: 1,
    describe: function (p) { return 'Act on ' + (p.id || '?'); },
    params: [{ key: 'id', label: 'Struct', kind: 'id', kinds: [5], placeholder: '5-4559' }],
    cadenceMs: 30000, usesRefs: true,
    render: function (host, p, ctx) {
      host.innerHTML = '';
      if (!p.id) { host.appendChild(H.stateBlock('info', 'Configure this card with a struct id.')); return; }
      var R = T.ensureRefs && T.ensureRefs();
      if (!R) { host.appendChild(H.stateBlock('error', 'Reference cards not loaded.')); return; }
      var ref = R.cards[p.id];
      if (!ref) { R.wantRefs([p.id]); host.appendChild(H.stateBlock('info', 'Looking up ' + p.id + '…')); return; }
      host.appendChild(window.StructsCards.struct.row({
        id: ref.id, type: ref.type_name, ambit: ref.ambit, location: ref.planet_id,
        health: ref.health, maxHealth: ref.health, online: ref.online, built: ref.built,
        destroyed: ref.destroyed, attn: ref.work_text || null,
      }, { onClick: function () { add('inspector', { id: ref.id }); } }));
      var verbs = structVerbs(ref);
      if (!verbs.length) {
        host.appendChild(H.stateBlock('info', ref.destroyed ? 'Destroyed — nothing to do.' : 'Not built yet — the build proof finishes it.'));
        return;
      }
      var slot = H.el('div', 'tm-ticket-slot');
      host.appendChild(doorRow(verbs.map(function (v) {
        /* Some verbs need a read before they can even draw their form —
         * Reposition cannot offer an ambit until it knows which ones this hull
         * may enter and which slots are open. The door does that read, so a
         * form is never a free-text guess at something the chain will refuse. */
        var draw = function (d) {
          slot.innerHTML = '';
          slot.appendChild(ticket({
            cta: v.label, danger: v.danger,
            fields: typeof v.fields === 'function' ? function (vals) { return v.fields(vals, d); } : (v.fields || []),
            confirm: function (vals) {
              if (v.needs && !vals[v.needs]) return null;
              return { title: v.label + '?', cta: v.label, rows: [['Struct', ref.id + ' · ' + (ref.type_name || '?')], ['Signing as', ref.owner || 'primary']]
                .concat(v.rows ? v.rows(vals, d) : Object.keys(vals).map(function (k) { return [k.replace(/_/g, ' '), String(vals[k] || '—')]; })) };
            },
            submit: function (vals) {
              if (v.needs && !vals[v.needs]) return Promise.reject(v.needs.replace(/_/g, ' ') + ' required');
              /* AS the struct's owner. Signing a worker's rig as the primary
               * is a permission error at best and the wrong account at
               * worst — the owner is on the reference record, so use it. */
              var call = v.via === 'action'
                ? invoke('mcp_action', { action: v.verb, args: v.args(vals) })
                : invoke('mcp_struct_act', { player: ref.owner || 'primary', action: v.verb, args: v.args(vals) });
              return call.then(function (msg) { Board.stamp && Board.stamp(String(msg).split('\n')[0]); });
            },
            done: function () { T.refresh(ctx.id, true); },
          }));
        };
        return { label: v.label, primary: !v.danger, onClick: function () {
          if (!v.prepare) { draw(null); return; }
          slot.innerHTML = '';
          slot.appendChild(H.stateBlock('info', 'Reading where it can go…'));
          v.prepare().then(draw).catch(function (e) {
            slot.innerHTML = '';
            slot.appendChild(H.stateBlock('error', String((e && e.message) || e)));
          });
        } };
      })));
      host.appendChild(slot);
    },
  });

  /* ── GRID RISK: what the chain destroys, and in what order ───────────────
   *
   * Two mechanics decide whether an infrastructure position holds, and no
   * card showed either.
   *
   * **GridCascade.** `grid_context.go:111` — if an object's load exceeds its
   * capacity, the keeper DESTROYS its outgoing allocations, in creation
   * order, until load fits again. Not throttles: destroys. So the question an
   * operator actually has is "if I lose capacity, what goes, and in what
   * order" — and the answer is a list the chain has already decided.
   *
   * **Dilution.** `connectionCapacity = (capacity − load) / connectionCount`
   * is recomputed on every connect, so each new player on a substation
   * SHRINKS everyone else's share. A player whose own margin looks fine can
   * be one connection away from a brownout they did not cause.
   *
   * Both are arithmetic on data `mcp_allocations` already returns.
   */
  var allocSeq = function (id) { var m = /-(\d+)$/.exec(String(id || '')); return m ? Number(m[1]) : Infinity; };
  var ORDINAL = ['1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th', '9th', '10th'];
  T.register('brownout', {
    label: 'Grid risk', defaultWidth: 2,
    describe: function () { return 'Grid risk'; },
    cadenceMs: 30000,
    render: function (host, p, ctx) {
      return invoke('mcp_allocations').then(function (d) {
        host.innerHTML = '';
        if (d && d._err) { host.appendChild(H.stateBlock('error', 'allocations unavailable: ' + d._err)); return; }
        var b = (d && d.budget) || {};
        var mine = ((d && d.allocations) || []).slice().sort(function (x, y) { return allocSeq(x.id) - allocSeq(y.id); });
        var routed = mine.reduce(function (n, a) { return n + (Number(a.power_mw) || 0); }, 0);
        var head = Number(b.allocatable_mw) || 0;
        host.appendChild(tiles([
          ['capacity', H.fmtWatts(b.capacity_mw || 0), 'sui-icon-energy'],
          [['routed out', 'load'], H.fmtWatts(routed), null, routed > (b.capacity_mw || 0) ? 'bad' : null],
          [['headroom', 'before a cascade'], H.fmtWatts(head), null, head <= 0 ? 'bad' : head < routed * 0.1 ? 'warn' : 'ok'],
          [['structs', b.online === false ? 'OFFLINE' : 'online'], H.fmtWatts(b.structs_load_mw || 0), null, b.online === false ? 'bad' : 'muted'],
        ]));
        /* The order the chain would destroy them in, with what each one sheds.
         * Reading down, an operator sees exactly how much capacity they can
         * lose before a given allocation goes. */
        if (mine.length) {
          var shed = 0;
          var table = H.resultTable();
          mine.forEach(function (a, i) {
            var power = Number(a.power_mw) || 0;
            shed += power;
            table.appendChild(window.StructsCards.row({
              kind: 'allocation',
              emblem: window.StructsCards.emblem.glyph(a.locked ? 'icon-key' : 'sui-icon-energy', 'sm', i === 0 ? 'enemy' : 'secondary'),
              title: (a.type || 'allocation') + ' → ' + (a.destination_id || '?'), id: a.id,
              sub: a.source_object_id ? 'from ' + a.source_object_id : null,
              attn: (ORDINAL[i] || (i + 1) + 'th') + ' to go',
              readings: [
                { value: H.fmtWatts(power), icon: 'sui-icon-energy', title: 'Power this allocation carries' },
                { value: H.fmtWatts(shed), icon: 'sui-icon-md icon-alert', title: 'Capacity you can lose before this one goes: everything above it, and it' },
              ],
            }, { onClick: function () { add('allocations', {}); } }));
          });
          host.appendChild(table);
        } else {
          host.appendChild(H.stateBlock('info', 'Nothing routed out — no allocation of ours can cascade.'));
        }
        /* And the other half: every substation's share, and what one more
         * connection does to it. */
        var subs = ((d && d.substations) || []).filter(function (x) { return (Number(x.connection_count) || 0) > 0; });
        subs.sort(function (x, y) { return (Number(x.connection_capacity_mw) || 0) - (Number(y.connection_capacity_mw) || 0); });
        if (subs.length) {
          cap(host, 'substations · thinnest share first');
          var st = H.resultTable();
          subs.slice(0, 12).forEach(function (x) {
            var free = Math.max(0, (Number(x.capacity_mw) || 0) - (Number(x.load_mw) || 0));
            var count = Number(x.connection_count) || 0;
            var now = Number(x.connection_capacity_mw) || (count ? free / count : 0);
            var next = free / (count + 1);
            st.appendChild(window.StructsCards.substation.row({
              id: x.id, guild: x.name || null, load: Number(x.load_mw) || 0, capacity: Number(x.capacity_mw) || 0,
              connections: count, perConnection: H.fmtWatts(now),
              fmt: H.fmtWatts,
              attn: now > 0 ? '−' + H.fmtWatts(now - next) + ' with one more' : 'nothing left to share',
            }, { onClick: function () { add('inspector', { id: x.id }); } }));
          });
          host.appendChild(st);
        }
      }).catch(function (e) { fail(host, 'grid risk', e); });
    },
  });

  /* ── SCOUT: the ambit they neither reach nor occupy ──────────────────────
   *
   * The one computed answer that decides fights. Every fleet weapon in the
   * game does 2 damage, so hulls differ by REACH, not firepower — and a
   * counter only fires when the defender's weapon reaches your ambit or the
   * defender is standing in it. Attack from an ambit that is neither and the
   * shot is free.
   *
   * Nobody can union nine hulls' weapon reach in their head while a raid's
   * four-minute window runs. Rust does it (`terminal_scout`, off the same
   * doctrine the strike planner uses); this reads it out.
   */
  var AMBIT_ICON = { space: 'icon-ambit-space', air: 'icon-ambit-air', land: 'icon-ambit-land', water: 'icon-ambit-water' };
  var AMBITS = ['space', 'air', 'land', 'water'];
  function ambitRow(label, list, tone, title) {
    var r = H.el('div', 'tm-ambits');
    var cap = H.el('span', 'fstat-l', label);
    r.appendChild(cap);
    AMBITS.forEach(function (a) {
      var on = (list || []).indexOf(a) >= 0;
      var chip = H.el('span', 'tm-ambit' + (on ? ' is-on ' + (tone || '') : ''));
      chip.textContent = a;
      chip.title = title || '';
      r.appendChild(chip);
    });
    return r;
  }
  function scoutSide(host, label, side, exposure) {
    if (!side || !side.count) return;
    var head = H.el('div', 'tm-cap');
    head.appendChild(H.el('span', 'fstat-l', label + ' · ' + side.count + ' live hull' + (side.count === 1 ? '' : 's')));
    host.appendChild(head);
    /* The free ambits FIRST — it is the answer, and everything under it is
     * the working. Nothing free is itself the finding: there is no safe
     * angle on this fleet. */
    host.appendChild(ambitRow('free', side.free, 'sc-ok', 'They neither reach nor stand in this ambit — a shot from here takes no counter'));
    if (!(side.free || []).length) host.appendChild(H.alertLine('No free ambit — every angle takes a counter.', 'icon-alert'));
    host.appendChild(ambitRow('they reach', side.reaches, 'sc-bad-text', 'Their weapons cover this ambit'));
    host.appendChild(ambitRow('they stand in', side.occupies, 'sc-bad-text', 'A hull standing here counters regardless of what its weapon reaches'));
    if (side.command && side.command.id) {
      // Killing it strands the fleet: no Command Ship, no raid, no movement.
      host.appendChild(H.row('Command ship', String(side.command.type || '?') + ' ' + side.command.id
        + ' · ' + String(side.command.ambit || '?')
        + (side.command.health != null ? ' · ' + side.command.health + '/' + side.command.max_health + ' HP' : ''), 'icon-alert'));
    }
    var table = H.resultTable();
    (side.hulls || []).forEach(function (h) {
      table.appendChild(window.StructsCards.struct.row({
        id: h.id, type: h.type, ambit: h.ambit, health: h.health, maxHealth: h.max_health,
        online: h.online, built: true, destroyed: false,
        // What this hull can shoot at, which is the only thing that decides
        // whether it can punish you — every fleet weapon does the same damage.
        attn: (h.is_command ? 'COMMAND · ' : '') + ((h.reaches || []).length ? 'reaches ' + h.reaches.join(' ') : 'reaches nothing'),
      }, { onClick: function () { add('inspector', { id: h.id }); } }));
    });
    host.appendChild(table);
    if (exposure) {
      var ex = H.el('div', 'tm-ambits');
      ex.appendChild(H.el('span', 'fstat-l', 'counters from'));
      AMBITS.forEach(function (a) {
        var n = Number(exposure[a] || 0);
        var chip = H.el('span', 'tm-ambit' + (n ? ' is-on sc-bad-text' : ' is-on sc-ok'));
        chip.textContent = a + ' ' + n;
        chip.title = n ? n + ' of their hulls would counter a shot fired from ' + a : 'A shot from ' + a + ' takes no counter';
        ex.appendChild(chip);
      });
      host.appendChild(ex);
    }
  }
  T.register('scout', {
    label: 'Scout a target', defaultWidth: 2,
    describe: function (p) { return 'Scout ' + (p.id || '?'); },
    params: [{ key: 'id', label: 'Planet or fleet', kind: 'id', kinds: [2, 9], placeholder: '2-15361' }],
    cadenceMs: 30000,
    render: function (host, p) {
      if (!p.id) { host.innerHTML = ''; host.appendChild(H.stateBlock('info', 'Configure this card with a planet or fleet id.')); return; }
      return Promise.all([invoke('terminal_scout', { target: p.id }), T.standingLists()]).then(function (res) {
        var d = res[0];
        host.innerHTML = '';
        /* Who holds this, and where we stand with them — BEFORE the hulls.
         * The automation obeys these lists; a person about to raid should see
         * what the automation sees, and "off-limits" is a thing you find out
         * before you look at their fleet, not after. */
        var stand = T.standingOf(res[1], d.owner, null);
        if (d.owner) {
          host.appendChild(window.StructsPlayerCard.row({
            id: d.owner, name: d.owner_name || d.owner, sub: 'holds ' + (d.planet_id || p.id),
            badge: stand ? stand.badge : null, attn: stand ? stand.note : null,
            err: !!(stand && stand.badge && stand.badge.text === 'OFF-LIMITS'),
          }, { actions: Board.reachActions ? Board.reachActions({ player_id: d.owner, player_name: d.owner_name }) : [] }));
        }
        host.appendChild(tiles([
          ['shield', d.shield == null ? '—' : H.fmtInt(d.shield), null, Number(d.shield) ? null : 'ok'],
          ['ore', d.stored_ore == null ? '—' : H.fmtOre(d.stored_ore)],
          [['defenders', 'live hulls'], H.fmtInt((d.defender && d.defender.count) || 0)],
          [['raiders', 'live hulls'], H.fmtInt((d.attacker && d.attacker.count) || 0), null, (d.attacker && d.attacker.count) ? 'bad' : 'muted'],
        ]));
        scoutSide(host, 'Holding ' + (d.planet_id || p.id), d.defender, d.defender && d.defender.exposure);
        scoutSide(host, 'Raiding it', d.attacker, d.attacker && d.attacker.exposure);
        if (!(d.defender && d.defender.count) && !(d.attacker && d.attacker.count)) {
          host.appendChild(H.stateBlock('info', 'Nothing live on ' + (d.planet_id || p.id) + '.'));
        }
      }).catch(function (e) { fail(host, 'scout', e); });
    },
  });

  // ── Power (mcp_energy / mcp_infusions / mcp_allocations) ─────────────────
  T.register('grid', {
    label: 'Guild power', describe: function () { return 'Guild power'; }, cadenceMs: 30000,
    render: function (host, p, ctx) {
      return invoke('mcp_energy').then(function (d) {
        host.innerHTML = '';
        var g = (d && d.guild) || {};
        var sub = H.scaleSet([g.sub_capacity_mw, g.sub_load_mw], 'power');
        host.appendChild(tiles([
          ['capacity', sub.fmt(g.sub_capacity_mw || 0), 'sui-icon-energy'],
          ['load', sub.fmt(g.sub_load_mw || 0), null, (g.sub_load_mw || 0) > (g.sub_capacity_mw || 0) * 0.9 ? 'bad' : null],
          ['connections', H.fmtInt(g.sub_connection_count || 0)],
        ]));
        host.appendChild(H.row('Per connection', H.fmtWatts(g.sub_connection_capacity_mw || 0) + ' → ' + H.fmtWatts(g.share_if_one_more_mw || 0) + ' with one more'));
        host.appendChild(H.row('Reactor fuel', H.fmtWatts(g.reactor_fuel_mw || 0) + ' · ' + Math.round((g.reactor_commission || 0) * 100) + '% commission'));
        host.appendChild(H.row('Headroom', '~' + H.fmtInt(g.supportable_more || 0) + ' more players', (g.supportable_more || 0) > 0 ? 'icon-success' : 'icon-alert'));
        /* Which reactor the guild draws from is a GUILD-ADMIN change and the
         * one lever on this card that is not a read. It is not undoable by
         * looking at it, so it names the reactor and the guild before it goes. */
        var slot = H.el('div', 'tm-ticket-slot');
        host.appendChild(doorRow([
          { label: 'Allocations', onClick: function () { add('allocations', {}); } },
          { label: 'Reactor fuel', onClick: function () { add('fuel', {}); } },
          { label: 'Primary reactor', onClick: function () {
            slot.innerHTML = '';
            slot.appendChild(ticket({
              cta: 'Set primary reactor', danger: true,
              fields: [{ key: 'reactor_id', label: 'Reactor', placeholder: '3-…' }],
              confirm: function (v) {
                if (!v.reactor_id) return null;
                return { title: 'Set the guild\'s primary reactor?', cta: 'Set', rows: [
                  ['Reactor', String(v.reactor_id)],
                  ['Guild', String(g.guild_id || d.guild_id || '—')],
                  ['Effect', 'every member draws from it'],
                ] };
              },
              submit: function (v) {
                if (!v.reactor_id) return Promise.reject('reactor required');
                return invoke('mcp_action', { action: 'update_primary_reactor', args: { reactor_id: v.reactor_id } })
                  .then(function (msg) { Board.stamp && Board.stamp(String(msg).split('\n')[0]); });
              },
              done: function () { T.refresh(ctx.id, true); },
            }));
          } },
        ]));
        host.appendChild(slot);
      }).catch(function (e) { fail(host, 'energy', e); });
    },
  });
  T.register('fuel', {
    label: 'Reactor fuel', defaultWidth: 1, describe: function () { return 'Reactor fuel'; }, cadenceMs: 60000,
    render: function (host, p, ctx) {
      return invoke('mcp_infusions').then(function (d) {
        host.innerHTML = '';
        if (d && d._err) { host.appendChild(H.stateBlock('error', 'infusions unavailable: ' + d._err)); return; }
        var t = (d && d.totals) || {};
        host.appendChild(tiles([
          ['staked', H.fmtAlpha(t.fuel_ualpha || 0), 'sui-icon-alpha-matter', 'ok'],
          ['capacity made', H.fmtWatts(t.capacity_mw || 0), 'sui-icon-energy', 'ok'],
          ['commission', H.fmtWatts(t.commission_mw || 0), null, 'muted'],
        ]));
        host.appendChild(tiles([
          ['defusing', H.fmtAlpha(t.defusing_ualpha || 0), null, (t.defusing_ualpha || 0) > 0 ? 'live' : 'muted'],
          ['earning nothing', H.fmtAlpha(t.dead_fuel_ualpha || 0), null, (t.dead_fuel_ualpha || 0) > 0 ? 'bad' : 'muted'],
          ['reactors', H.fmtInt(((d && d.reactors) || []).length)],
        ]));
        var ai = d && d.auto_infuse;
        host.appendChild(H.row('Auto infuse', ai && ai.enabled ? 'ON · keeps ' + H.fmtInt(ai.keep_grams) + 'g · every ' + H.duration(ai.interval_secs) : 'off', ai && ai.enabled ? 'icon-success' : 'icon-blocked'));
        var pend = ((d && d.pending) || []).length, migs = ((d && d.migrations) || []).length;
        if (pend || migs) host.appendChild(H.alertLine(pend + ' in flight · ' + migs + ' migrating', 'icon-in-progress'));

        // Staking alpha into a reactor is how a guild makes power, and this
        // card named dead fuel for months without offering to move it.
        var mine = (d.infusions || []).filter(function (r) { return (r.fuel_ualpha || 0) > 0; });
        var reactorOpts = ((d.reactors) || []).map(function (r) {
          return { value: r.id, label: r.id + (r.moniker ? ' · ' + r.moniker : '') + ' · ' + Math.round((r.commission || 0) * 100) + '%' };
        });
        var mineOpts = mine.map(function (r) {
          return { value: r.destination_id, label: (r.destination_label || r.destination_id) + ' · ' + H.fmtAlpha(r.fuel_ualpha) };
        });
        var addressOf = function (dest) {
          var row = mine.filter(function (r) { return r.destination_id === dest; })[0];
          return (row && row.address) || d.address;
        };
        if (!reactorOpts.length && !mineOpts.length) return;
        host.appendChild(ticket({
          cta: 'Sign',
          fields: function (v) {
            var op = v.op || 'infuse';
            var f = [{ key: 'op', label: 'Ticket', kind: 'choice', value: op, options: [
              { value: 'infuse', label: 'Infuse alpha' },
              { value: 'defuse', label: 'Defuse alpha' },
              { value: 'migrate', label: 'Migrate alpha' },
            ] }];
            var opts = op === 'infuse' ? reactorOpts : (mineOpts.length ? mineOpts : reactorOpts);
            f.push({ key: 'dest', label: op === 'migrate' ? 'From reactor' : 'Reactor', kind: 'choice', value: v.dest, options: opts });
            if (op === 'migrate') f.push({ key: 'target', label: 'To reactor', kind: 'choice', value: v.target, options: reactorOpts });
            f.push({ key: 'amount', label: 'Alpha (ualpha)', value: v.amount, placeholder: '1000000' });
            return f;
          },
          preview: function (v) {
            var amt = Math.round(Number(v.amount));
            if (!v.dest || !isFinite(amt) || amt <= 0) return null;
            if (v.op === 'migrate' && !v.target) return null;
            return invoke('mcp_infusion_preview', {
              op: v.op || 'infuse', address: addressOf(v.dest), destinationId: v.dest,
              targetId: v.op === 'migrate' ? v.target : null, amountUalpha: amt,
            });
          },
          facts: function (p) {
            var f = p.facts || {};
            if ((p.op || '') === 'migrate') return [['net capacity', H.fmtWatts(f.net_mw || 0), null, (f.net_mw || 0) < 0 ? 'bad' : 'ok']];
            if ((p.op || '') === 'defuse') return [
              ['capacity lost', H.fmtWatts(f.capacity_lost_mw || 0), 'sui-icon-energy', 'bad'],
              ['back in', H.duration(f.cooldown_secs || 0), null, 'muted'],
            ];
            return [
              ['capacity gained', H.fmtWatts(f.gained_mw || 0), 'sui-icon-energy', 'ok'],
              ['commission', H.fmtWatts(f.commission_mw || 0), null, 'muted'],
              ['alpha after', H.fmtAlpha(f.balance_after_ualpha || 0), 'sui-icon-alpha-matter'],
            ];
          },
          confirm: function (v) {
            var word = v.op === 'defuse' ? 'Remove this alpha from the reactor?' : v.op === 'migrate' ? 'Move this alpha between reactors?' : 'Stake this alpha into the reactor?';
            var rows = [['Alpha', H.fmtAlpha(Number(v.amount) || 0)], ['Reactor', v.dest]];
            if (v.op === 'migrate') rows.push(['To', v.target]);
            return { title: word, rows: rows, cta: v.op === 'defuse' ? 'Defuse' : v.op === 'migrate' ? 'Migrate' : 'Infuse' };
          },
          submit: function (v) {
            var amt = Math.round(Number(v.amount));
            var addr = addressOf(v.dest);
            if (v.op === 'defuse') return invoke('mcp_infusion_defuse', { address: addr, reactorId: v.dest, amountUalpha: amt });
            if (v.op === 'migrate') return invoke('mcp_infusion_migrate', { address: addr, fromReactorId: v.dest, toReactorId: v.target, amountUalpha: amt });
            return invoke('mcp_infusion_infuse', { address: addr, reactorId: v.dest, amountUalpha: amt });
          },
          done: function () { T.refresh(ctx.id, true); },
        }));
      }).catch(function (e) { fail(host, 'infusions', e); });
    },
  });

  T.register('allocations', {
    label: 'Allocations', describe: function () { return 'Allocations'; }, cadenceMs: 30000,
    render: function (host, p, ctx) {
      return invoke('mcp_allocations').then(function (d) {
        host.innerHTML = '';
        if (d && d._err) { host.appendChild(H.stateBlock('error', 'allocations unavailable: ' + d._err)); return; }
        var b = (d && d.budget) || {}, rows = (d && d.allocations) || [];
        host.appendChild(tiles([
          ['allocatable', H.fmtWatts(b.allocatable_mw || 0), 'sui-icon-energy'],
          ['available', H.fmtWatts(b.available_mw || 0), null, (b.available_mw || 0) <= 0 ? 'bad' : 'ok'],
          ['allocations', H.fmtInt(rows.length)],
        ]));
        // Routing power is the point of the card; it used to only describe it.
        var openTicket = function (seed) {
          var slot = host.querySelector('.tm-ticket-slot');
          if (!slot) return;
          slot.innerHTML = '';
          slot.appendChild(seed);
        };
        var table = H.resultTable();
        rows.forEach(function (a) {
          table.appendChild(window.StructsCards.row({
            kind: 'allocation', emblem: window.StructsCards.emblem.glyph(a.locked ? 'icon-key' : 'sui-icon-energy', 'sm', a.locked ? 'hint' : 'secondary'),
            title: (a.type || 'allocation') + ' → ' + (a.destination_id || '?'), id: a.id,
            sub: a.source_object_id ? 'from ' + a.source_object_id : null, attn: a.locked ? 'locked' : null,
            readings: [{ value: H.fmtWatts(a.power_mw || 0), icon: 'sui-icon-energy', title: 'Power allocated' }],
          }, {
            doors: a.locked ? [] : [{ icon: 'icon-edit', title: 'Set the power on this allocation', onClick: function () {
              openTicket(ticket({
                cta: 'Set power',
                fields: [{ key: 'mw', label: 'Power (mW)', value: String(Math.round(a.power_mw || 0)), placeholder: '0' }],
                preview: function (v) {
                  var mw = Math.round(Number(v.mw));
                  if (!isFinite(mw) || mw < 0) return null;
                  return invoke('mcp_allocation_preview', { allocationId: a.id, powerMw: mw });
                },
                facts: function (pv) {
                  return [
                    [(pv.delta_mw || 0) >= 0 ? 'adds to load' : 'frees load', H.fmtWatts(Math.abs(pv.delta_mw || 0)), 'sui-icon-energy', (pv.delta_mw || 0) >= 0 ? null : 'ok'],
                    ['headroom after', H.fmtWatts(pv.projected_headroom_mw || 0), null, (pv.projected_headroom_mw || 0) < 0 ? 'bad' : 'ok'],
                  ];
                },
                confirm: function (v) {
                  return { title: 'Set allocation power?', cta: 'Apply', rows: [['From', H.fmtWatts(a.power_mw || 0)], ['To', H.fmtWatts(Number(v.mw) || 0)]] };
                },
                submit: function (v) { return invoke('mcp_allocation_set_power', { allocationId: a.id, powerMw: Math.round(Number(v.mw)) }); },
                done: function () { T.refresh(ctx.id, true); },
              }));
            } }],
          }));
        });
        if (rows.length) host.appendChild(table);
        else host.appendChild(H.stateBlock('info', 'No allocations.'));
        host.appendChild(doorRow([{ label: 'New allocation', primary: true, onClick: function () {
          openTicket(ticket({
            cta: 'Create',
            fields: [
              { key: 'source', label: 'From object', value: d.player_id || '', placeholder: '1-194' },
              { key: 'type', label: 'Type', kind: 'choice', options: [{ value: 'dynamic', label: 'Dynamic' }, { value: 'static', label: 'Static' }] },
              { key: 'mw', label: 'Power (mW)', placeholder: '0' },
            ],
            confirm: function (v) { return { title: 'Create this allocation?', cta: 'Create', rows: [['From', v.source], ['Type', v.type], ['Power', H.fmtWatts(Number(v.mw) || 0)]] }; },
            submit: function (v) { return invoke('mcp_allocation_create', { sourceObjectId: v.source, allocationType: v.type, powerMw: Math.round(Number(v.mw)) }); },
            done: function () { T.refresh(ctx.id, true); },
          }));
        } }]));
        host.appendChild(H.el('div', 'tm-ticket-slot'));
      }).catch(function (e) { fail(host, 'allocations', e); });
    },
  });

  // ── Roster (mcp_roster / mcp_mass_action) ────────────────────────────────
  var ROLE_OPTS = [{ value: '', label: 'every role' }, { value: 'primary', label: 'primary' }, { value: 'productive', label: 'productive' }, { value: 'raider', label: 'raider' }, { value: 'bait', label: 'bait' }];
  var SORT_OPTS = [{ value: 'alpha', label: 'by Alpha' }, { value: 'ore', label: 'by ore' }, { value: 'charge', label: 'by charge' }, { value: 'stale', label: 'stalest read' }];
  // "Armada", not "Fleet": a FLEET is a thing in the game — a 9-… object that
  // sits at a planet and carries structs — and this card is the roster of the
  // players we run. Naming it Fleet made the word mean two things.
  T.register('armada', {
    label: 'Armada', defaultWidth: 2,
    describe: function (p) { return 'Armada' + (p.role ? ' · ' + p.role : '') + (p.sort ? ' · ' + p.sort : ''); },
    params: [{ key: 'role', label: 'Role', kind: 'choice', options: ROLE_OPTS }, { key: 'sort', label: 'Order', kind: 'choice', options: SORT_OPTS }],
    cadenceMs: 30000,
    render: function (host, p, ctx) {
      return invoke('mcp_roster', { refreshIfOlderMs: 120000 }).then(function (snap) {
        host.innerHTML = '';
        var rows = ((snap && snap.rows) || []).filter(function (r) { return !p.role || r.role === p.role; });
        var key = p.sort || 'alpha';
        rows.sort(function (a, b) {
          if (key === 'stale') return (a.fetched_at_ms || 0) - (b.fetched_at_ms || 0);
          if (key === 'charge') return (b.charge || 0) - (a.charge || 0);
          if (key === 'ore') return (b.ore || 0) - (a.ore || 0);
          return (b.alpha_ualpha || 0) - (a.alpha_ualpha || 0);
        });
        var total = rows.reduce(function (s, r) { return s + (r.alpha_ualpha || 0); }, 0);
        var ore = rows.reduce(function (s, r) { return s + (r.ore || 0); }, 0);
        host.appendChild(tiles([
          ['players', H.fmtInt(rows.length)],
          ['alpha', H.fmtAlpha(total), 'sui-icon-alpha-matter'],
          ['ore', H.fmtOre(ore), 'sui-icon-alpha-ore'],
          ['roster age', snap && snap.refreshed_at_ms ? H.ago(snap.refreshed_at_ms) : '—', null, 'muted'],
        ]));
        // Sweep: the first click is a dry run that prices the click; the
        // second click executes exactly what the first one said.
        // Creating a virtual player lived only in the agent's tool surface;
        // the Armada page names and styles the roster but cannot add to it.
        var slot = H.el('div', 'tm-ticket-slot');
        var newPlayer = function () {
          slot.innerHTML = '';
          slot.appendChild(ticket({
            cta: 'Create',
            fields: [
              { key: 'name', label: 'Name', placeholder: 'named from its index if blank' },
              { key: 'role', label: 'Role', kind: 'choice', options: ROLE_OPTS.filter(function (o) { return o.value; }) },
              { key: 'index', label: 'HD index', placeholder: 'next free' },
            ],
            confirm: function (v) {
              return { title: 'Create a virtual player?', cta: 'Create', rows: [
                ['Name', v.name || 'from its HD index'],
                ['Role', v.role || 'productive'],
                ['Index', v.index || 'next free'],
              ] };
            },
            submit: function (v) {
              var args = { command: 'create', role: v.role || null };
              if (v.name) args.name = v.name;
              if (v.index) args.index = Math.max(1, Number(v.index) || 0);
              return invoke('mcp_players', args);
            },
            done: function () { invoke('mcp_roster_refresh', {}).catch(function () {}); T.refresh(ctx.id, true); },
          }));
        };
        var sweep = { armed: false };
        host.appendChild(slot);
        host.appendChild(doorRow([
          { label: 'New player', onClick: newPlayer },
          { label: 'Sweep Alpha', primary: true, onClick: function (a) {
            if (!sweep.armed) {
              invoke('mcp_mass_action', { request: { action: 'sweep_alpha', mode: 'dry_run' } }).then(function (r) {
                var n = (r && r.entries || []).length;
                if (!n) { a.textContent = 'Nothing to sweep'; return; }
                a.textContent = 'Confirm sweep of ' + n + ' ~' + H.fmtAlpha(Number(r.total_alpha || 0) * 1e6);
                sweep.armed = true;
              }).catch(function (e) { a.textContent = 'Sweep: ' + e; });
            } else {
              invoke('mcp_mass_action', { request: { action: 'sweep_alpha', mode: 'execute' } }).then(function () { a.textContent = 'Sweeping…'; sweep.armed = false; }).catch(function (e) { a.textContent = 'Sweep: ' + e; });
            }
          } },
          { label: 'Refresh roster', onClick: function (a) { invoke('mcp_roster_refresh').then(function () { a.textContent = 'Sweeping roster…'; }); } },
        ]));
        if (!rows.length) { host.appendChild(H.stateBlock('info', 'No roster yet.')); return; }
        var table = H.resultTable();
        rows.slice(0, 30).forEach(function (r) {
          var stale = r.err || (Date.now() - (r.fetched_at_ms || 0) > 2 * 3600 * 1000);
          /* A player with no planet has never explored, and until it does it
           * is an empty guild membership: no planet, no fleet, no command
           * ship, and every other verb refuses. Creating one from this card
           * left exactly that state with nothing here to finish it. */
          var unstarted = !r.planet_id;
          table.appendChild(PC().row({
            id: r.player_id, name: r.name || r.player_id, pfp: r.pfp_attrs, sub: r.role || null, err: !!r.err,
            attn: r.err ? 'read failed' : unstarted ? 'never explored' : (stale ? 'read ' + H.ago(r.fetched_at_ms) + ' ago' : null),
            readings: [
              { value: H.fmtAlpha(r.alpha_ualpha || 0), icon: 'sui-icon-alpha-matter', title: 'Alpha' },
              { value: H.fmtOre(r.ore || 0), icon: 'sui-icon-alpha-ore', title: 'Ore' },
              { value: r.charge == null ? '—' : String(r.charge) + '/8', icon: 'sui-icon-value', title: 'Charge' },
            ],
          }, { actions: (Board.watchActions ? Board.watchActions(r) : []).concat([
            { icon: 'icon-member', title: 'Watch this player', onClick: function () { add('player', { id: r.player_id }); } },
          ]).concat(unstarted ? [{ icon: 'icon-beacon', title: 'Explore — give ' + (r.name || r.player_id) + ' a planet and a fleet', onClick: function () {
            var body = H.el('div');
            body.appendChild(H.fact ? H.fact('Player', r.player_id) : H.row('Player', r.player_id));
            body.appendChild(H.fact ? H.fact('Gets', 'a planet, a fleet and a command ship') : H.row('Gets', 'a planet, a fleet and a command ship'));
            H.confirmModal('Explore for ' + (r.name || r.player_id) + '?', body, 'Explore', function () {
              invoke('terminal_player_explore', { player: r.player_id })
                .then(function (msg) { Board.stamp && Board.stamp(String(msg).split('\n')[0]); T.refresh(ctx.id, true); })
                .catch(function (e) { Board.stamp && Board.stamp('explore: ' + e); });
            });
          } }] : []) }));
        });
        host.appendChild(table);
      }).catch(function (e) { fail(host, 'roster', e); });
    },
  });

  // ── Raids (mcp_raids) ────────────────────────────────────────────────────
  T.register('raids', {
    label: 'Raids',
    describe: function (p) { return 'Raids' + (p.scope ? ' · ' + p.scope : ''); },
    params: [{ key: 'scope', label: 'Show', kind: 'choice', options: [{ value: '', label: 'all tracked' }, { value: 'live', label: 'live now' }, { value: 'ours', label: 'involving us' }] }],
    cadenceMs: 10000,
    render: function (host, p) {
      return invoke('mcp_raids').then(function (d) {
        host.innerHTML = '';
        var all = (d && d.raids) || [];
        host.appendChild(tiles([
          ['live now', H.fmtInt(d.live || 0), 'icon-raid', d.live ? 'live' : 'muted'],
          ['involving us', H.fmtInt(d.ours || 0), null, d.ours ? 'bad' : 'muted'],
          ['tracked', H.fmtInt(all.length)],
        ]));
        var rows = all.filter(function (r) {
          if (p.scope === 'live') return r.live;
          if (p.scope === 'ours') return r.our_side && r.our_side !== 'none';
          return true;
        });
        if (!rows.length) { host.appendChild(H.stateBlock('info', 'No raids to show.')); return; }
        if (rows.length > 25) cap(host, 'showing 25 of ' + rows.length);
        var table = H.resultTable();
        rows.slice(0, 25).forEach(function (r) {
          table.appendChild(window.StructsCards.raid.row({
            planetId: r.planet_id, live: !!r.live, status: human(r.status), since: H.ago(r.updated_ms), stale: !!r.stale,
            ore: H.fmtOre(r.seized_ore || 0), oreLabel: 'Ore seized',
            attacker: r.attacker ? { id: r.attacker } : null, defender: r.defender ? { id: r.defender } : null,
          }, {
            onClick: function () { add('planet', { id: r.planet_id }); },
            onEmblem: function () { add('map', { id: r.planet_id }); },
            doors: [
              { icon: 'icon-raid', title: 'Watch this raid in its own window', onClick: function () {
                invoke('mcp_raid_view_open', { planetId: r.planet_id }).catch(function (e) { Board.stamp && Board.stamp('raid view: ' + e); });
              } },
              { icon: 'icon-combat-log', title: 'Battle log', onClick: function () { add('log', { id: r.planet_id }); } },
              // Mid-raid, the question is where to shoot from — and the four
              // minutes it takes to answer by hand are the whole window.
              { icon: 'icon-range', title: 'Scout both sides — where can we shoot from?', onClick: function () { add('scout', { id: r.planet_id }); } },
            ],
          }));
        });
        host.appendChild(table);
      }).catch(function (e) { fail(host, 'raids', e); });
    },
  });

  // ── War (mcp_war_bundle / mcp_config_set) ────────────────────────────────
  function warSet(payload, ctx) {
    return invoke('mcp_config_set', { domain: 'combat_lists', payload: payload }).then(function () { T.refresh(ctx.id, true); }).catch(function (e) { Board.stamp && Board.stamp('war: ' + e); });
  }
  function loopToggle(which, cfg, ctx) {
    var next = Object.assign({}, cfg, { enabled: !cfg.enabled });
    return invoke('mcp_config_set', { domain: 'loop', payload: { loop: which, config: next } }).then(function () { T.refresh(ctx.id, true); }).catch(function (e) { Board.stamp && Board.stamp('loop: ' + e); });
  }
  var AUTONOMY_OPTS = [{ value: 'off', label: 'off' }, { value: 'advise', label: 'advise' }, { value: 'act', label: 'act' }];
  var POSTURE_OPTS = [{ value: 'opportunist', label: 'opportunist' }, { value: 'aggressive', label: 'aggressive' }, { value: 'defensive', label: 'defensive' }];
  T.register('posture', {
    label: 'War posture', describe: function () { return 'War posture'; }, cadenceMs: 15000,
    render: function (host, p, ctx) {
      return invoke('mcp_war_bundle').then(function (d) {
        host.innerHTML = '';
        var resp = d.response || {}, raid = d.raid || {}, sb = d.shot_budget || {};
        // The two loops as loop cards (structs-cards.js): the game's own
        // switch is the control, the badge the state, the hold reason a mark.
        var grid = H.el('div', 'pc-grid');
        grid.appendChild(window.StructsCards.loop.card({
          key: 'response', name: 'Auto response', on: !!resp.enabled, cadence: 'event', icon: 'icon-counter', dryRun: !!resp.dry_run,
          figures: [{ value: String(resp.autonomy || '?'), icon: 'sui-icon-md icon-computer', title: 'Autonomy' },
                    { value: H.fmtInt(sb.used || 0) + ' / ' + H.fmtInt(sb.cap || 0), icon: 'sui-icon-md icon-dmg', title: 'Shots this window' }],
          holding: resp.enabled && resp.blocked_reason ? String(resp.blocked_reason) : null,
        }, { onToggle: function () { loopToggle('response', resp, ctx); } }));
        grid.appendChild(window.StructsCards.loop.card({
          key: 'raid', name: 'Auto raid', on: !!raid.enabled, cadence: raid.scan_interval_secs ? raid.scan_interval_secs + 's' : null, icon: 'icon-raid', dryRun: !!raid.dry_run,
          figures: [{ value: String(raid.autonomy || '?'), icon: 'sui-icon-md icon-computer', title: 'Autonomy' },
                    { value: String(raid.posture || '?'), icon: 'sui-icon-md icon-range', title: 'Posture' }],
          holding: raid.enabled && raid.blocked_reason ? String(raid.blocked_reason) : null,
        }, { onToggle: function () { loopToggle('raid', raid, ctx); } }));
        host.appendChild(grid);
        // Autonomy and posture decide what the loops are ALLOWED to do, and
        // changing them used to mean leaving for a settings page.
        var pick = function (label, value, options, apply) {
          var sel = H.selectBox(String(value || options[0].value), options, function () {
            invoke('mcp_config_set', { domain: 'loop', payload: apply(readControl(sel)) })
              .then(function () { T.refresh(ctx.id, true); })
              .catch(function (e) { Board.stamp && Board.stamp('loop: ' + e); });
          });
          return H.field(label, sel);
        };
        var strip = H.el('div', 'tm-config tm-posture-config');
        strip.appendChild(pick('Response autonomy', resp.autonomy, AUTONOMY_OPTS, function (v) {
          return { loop: 'response', config: Object.assign({}, resp, { autonomy: v }) };
        }));
        strip.appendChild(pick('Raid autonomy', raid.autonomy, AUTONOMY_OPTS, function (v) {
          return { loop: 'raid', config: Object.assign({}, raid, { autonomy: v }) };
        }));
        strip.appendChild(pick('Raid posture', raid.posture, POSTURE_OPTS, function (v) {
          return { loop: 'raid', config: Object.assign({}, raid, { posture: v }) };
        }));
        host.appendChild(strip);
      }).catch(function (e) { fail(host, 'war', e); });
    },
  });
  T.register('targets', {
    label: 'Target board', defaultWidth: 2,
    describe: function (p) { return 'Target board' + (p.sort ? ' · ' + p.sort : ''); },
    params: [{ key: 'sort', label: 'Order', kind: 'choice', options: [
      { value: 'score', label: 'by score' }, { value: 'ore', label: 'by ore' }, { value: 'shield', label: 'weakest shield' }, { value: 'raid_minutes', label: 'quickest proof' },
    ] }],
    cadenceMs: 30000,
    render: function (host, p, ctx) {
      return invoke('mcp_war_bundle').then(function (d) {
        host.innerHTML = '';
        var raid = d.raid || {}, targets = d.targets || [];
        var key = p.sort || 'score';
        targets = targets.slice().sort(function (a, b) {
          if (key === 'shield' || key === 'raid_minutes') return (Number(a[key]) || 0) - (Number(b[key]) || 0);
          return (Number(b[key === 'ore' ? 'stored_ore' : key]) || 0) - (Number(a[key === 'ore' ? 'stored_ore' : key]) || 0);
        });
        var go = targets.filter(function (t) { return !t.blocked_by; }).length;
        cap(host, targets.length + ' scored · ' + go + ' GO' + (targets.length > 20 ? ' · showing 20' : '') + (raid.enabled ? '' : ' · raiding is off'));
        if (!targets.length) { host.appendChild(H.stateBlock('info', 'No targets scored yet.')); return; }
        // Catalogue rows (structs-cards.js): GO/NO-GO as the badge and the
        // stripe, the reason on the id line, the planet as a chip, four
        // readings, and the three verbs as doors — grudge and veto write
        // combat_lists, the same path the WAR page uses.
        var C = window.StructsCards;
        var table = H.resultTable();
        targets.slice(0, 20).forEach(function (t) {
          var ok = !t.blocked_by;
          var thin = (t.stored_ore || 0) < (raid.min_ore || 0);
          table.appendChild(C.row({
            kind: 'target', emblem: C.emblem.glyph(ok ? 'icon-raid' : 'icon-blocked', 'sm', ok ? 'enemy' : 'hint'),
            title: t.name || t.player_id, id: t.player_id, sub: ok ? (t.vulnerability_reason || null) : null,
            attn: ok ? null : t.blocked_by, state: ok ? 'bad' : null,
            badge: ok ? { text: 'GO', mod: 'destructive' } : { text: 'NO-GO', mod: 'default' },
            chips: t.planet_id ? [C.planet.chip({ id: t.planet_id }, { onClick: function () { add('planet', { id: t.planet_id }); } })] : null,
            readings: [
              { value: H.fmtOre(t.stored_ore || 0), icon: 'sui-icon-alpha-ore', title: thin ? 'Stored ore · under the raid minimum' : 'Stored ore', cls: thin ? 'sc-bad-text' : null },
              { value: String(t.planetary_shield || 0) + ' · ~' + Math.round(t.raid_minutes || 0) + 'm', icon: 'sui-icon-md icon-planetary-shield', title: 'Shield · time to prove a raid' },
              { value: t.defenders_on_cmd == null ? '—' : String(t.defenders_on_cmd), icon: 'sui-icon-md icon-defend', title: 'Defenders on the command ship' },
              { value: String(Math.round(t.score || 0)), icon: 'sui-icon-md icon-range', title: 'Target score', cls: ok ? 'sc-ok' : null },
            ],
          }, {
            onClick: t.planet_id ? function () { add('planet', { id: t.planet_id }); } : null,
            doors: [
              // The board scores a target and then could only ever describe
              // it: the verb lives in `mcp_action`, the same one the agent
              // calls, with the same home guard and approval surface.
              ok ? { icon: 'icon-raid', title: 'Raid ' + t.planet_id, destructive: true, onClick: function () {
                var body = H.el('div');
                body.appendChild(H.fact ? H.fact('Planet', String(t.planet_id)) : H.row('Planet', String(t.planet_id)));
                body.appendChild(H.fact ? H.fact('Holder', String(t.name || t.player_id)) : H.row('Holder', String(t.name || t.player_id)));
                body.appendChild(H.fact ? H.fact('Ore at stake', H.fmtOre(t.stored_ore || 0)) : H.row('Ore at stake', H.fmtOre(t.stored_ore || 0)));
                body.appendChild(H.fact ? H.fact('Shield · proof', (t.planetary_shield || 0) + ' · ~' + Math.round(t.raid_minutes || 0) + 'm') : H.row('Shield', String(t.planetary_shield || 0)));
                H.confirmModal('Raid this planet? It seizes their ore and provokes their defence.', body, 'Raid', function () {
                  invoke('mcp_action', { action: 'raid', args: { target_id: t.planet_id } })
                    .then(function (msg) { Board.stamp && Board.stamp(String(msg).split('\n')[0]); T.refresh(ctx.id, true); })
                    .catch(function (e) { Board.stamp && Board.stamp('raid: ' + e); });
                });
              } } : null,
              /* Scout BEFORE you raid. The board scores a target on ore,
               * shield and defender count; none of that says which ambit you
               * can shoot from, which is what decides whether the raid costs
               * you hulls. One door between the two. */
              { icon: 'icon-range', title: 'Scout ' + t.planet_id + ' — where can we shoot from?', onClick: function () { add('scout', { id: t.planet_id }); } },
              { icon: 'icon-planet', title: 'Open planet ' + t.planet_id, onClick: function () { add('planet', { id: t.planet_id }); } },
              { icon: 'icon-attention', title: 'Add ' + t.player_id + ' to the grudge list', onClick: function () { warSet({ action: 'add', kind: 'grudge', id: t.player_id, label: t.name, guild_id: t.guild_id, weight: 1.5 }, ctx); } },
              { icon: 'icon-blocked', title: 'Never attack ' + t.player_id, destructive: true, onClick: function () { warSet({ action: 'add', kind: 'protected', id: t.player_id }, ctx); } },
            ].filter(Boolean),
          }));
        });
        host.appendChild(table);
      }).catch(function (e) { fail(host, 'war', e); });
    },
  });
  T.register('grudges', {
    label: 'Grudges', describe: function () { return 'Grudges'; }, cadenceMs: 30000,
    render: function (host, p, ctx) {
      return invoke('mcp_war_bundle').then(function (d) {
        host.innerHTML = '';
        var grudges = ((d.lists || {}).grudges) || [];
        if (!grudges.length) { host.appendChild(H.stateBlock('info', 'No grudges held.')); return; }
        var C = window.StructsCards;
        var table = H.resultTable();
        grudges.forEach(function (g) {
          table.appendChild(C.row({
            kind: 'grudge', emblem: C.emblem.glyph(g.muted ? 'icon-unknown' : 'icon-enemy-tile', 'sm', g.muted ? 'hint' : 'enemy'),
            title: g.label || g.player_id, id: g.player_id, sub: [g.guild_id ? 'guild ' + g.guild_id : null, g.source || null].filter(Boolean).join(' · ') || null,
            attn: g.muted ? 'muted' : (g.expired ? 'lapsed' : null), state: g.muted || g.expired ? null : 'bad',
            badge: { text: '×' + (Math.round((g.weight || 1) * 10) / 10), mod: g.muted ? 'default' : 'destructive' },
            readings: [
              { value: String(g.attacks || 0), icon: 'sui-icon-md icon-counter', title: 'Attacks on us' },
              { value: String(g.structs_lost || 0), icon: 'sui-icon-md icon-wreckage', title: 'Structs we lost to them' },
              { value: String(g.damage_taken || 0), icon: 'sui-icon-md icon-dmg', title: 'Damage taken' },
              { value: String(Math.round((g.heat || 0) * 100) / 100), icon: 'sui-icon-md icon-attention', title: 'Heat', cls: g.muted ? null : 'sc-bad-text' },
            ],
          }, {
            onClick: function () { add('player', { id: g.player_id }); },
            doors: [
              { icon: g.muted ? 'icon-okay' : 'icon-blocked', title: g.muted ? 'Unmute' : 'Mute — keep the record, stop acting on it', on: g.muted, onClick: function () { warSet({ action: g.muted ? 'unmute' : 'mute', kind: 'grudge', id: g.player_id }, ctx); } },
              { icon: 'icon-subtract', title: 'Forget this grudge', destructive: true, onClick: function () { warSet({ action: 'remove', kind: 'grudge', id: g.player_id }, ctx); } },
            ],
          }));
        });
        host.appendChild(table);
      }).catch(function (e) { fail(host, 'war', e); });
    },
  });
  T.register('vetoes', {
    label: 'Never attack', describe: function () { return 'Never attack'; }, cadenceMs: 60000,
    render: function (host, p, ctx) {
      return invoke('mcp_war_bundle').then(function (d) {
        host.innerHTML = '';
        var l = d.lists || {};
        var prot = l.protected_players || [], allies = l.allies || [], prio = l.priority_guilds || [];
        host.appendChild(tiles([['protected', H.fmtInt(prot.length)], ['ally guilds', H.fmtInt(allies.length)], ['priority guilds', H.fmtInt(prio.length)]]));
        var C = window.StructsCards;
        var table = H.resultTable();
        var line = function (icon, tone, title, id, kind, badge, open) {
          return C.row({
            kind: kind, emblem: C.emblem.glyph(icon, 'sm', tone), title: title, id: id, badge: badge || null,
          }, {
            onClick: open,
            doors: [{ icon: 'icon-subtract', title: 'Remove ' + id, destructive: true, onClick: function () { warSet({ action: 'remove', kind: kind, id: id }, ctx); } }],
          });
        };
        prot.forEach(function (pid) { table.appendChild(line('icon-blocked', 'warning', 'Protected player', pid, 'protected', null, function () { add('player', { id: pid }); })); });
        allies.forEach(function (gid) { table.appendChild(line('icon-guild', 'player', 'Ally guild', gid, 'ally', null, function () { add('guild', { id: gid }); })); });
        prio.forEach(function (g) { table.appendChild(line('icon-attention', 'enemy', 'Priority guild', g.guild_id, 'priority_guild', { text: '×' + g.weight, mod: 'destructive' }, function () { add('guild', { id: g.guild_id }); })); });
        if (prot.length || allies.length || prio.length) host.appendChild(table);
        // Adding a veto used to mean finding the player on the target board.
        host.appendChild(ticket({
          cta: 'Add',
          fields: [
            { key: 'kind', label: 'Never attack', kind: 'choice', options: [
              { value: 'protected', label: 'a player' }, { value: 'ally', label: 'an ally guild' }, { value: 'priority_guild', label: 'a priority guild' },
            ] },
            { key: 'id', label: 'Id', placeholder: '1-248 or 0-1' },
          ],
          confirm: function (v) { return { title: 'Add to the never-attack list?', cta: 'Add', rows: [['Kind', v.kind], ['Id', v.id]] }; },
          submit: function (v) { return warSet({ action: 'add', kind: v.kind, id: v.id }, ctx); },
          done: function () { T.refresh(ctx.id, true); },
        }));
        if (!prot.length && !allies.length && !prio.length) host.appendChild(H.stateBlock('info', 'No vetoes or priorities set.'));
      }).catch(function (e) { fail(host, 'war', e); });
    },
  });
  T.register('incidents', {
    label: 'Incidents', defaultWidth: 2, describe: function () { return 'Incidents'; }, cadenceMs: 30000,
    render: function (host) {
      return invoke('mcp_war_bundle').then(function (d) {
        host.innerHTML = '';
        var inc = d.incidents || [];
        if (!inc.length) { host.appendChild(H.stateBlock('info', 'No incidents recorded.')); return; }
        var table = H.resultTable();
        var clock = function (ms) { var d = new Date(Number(ms) || 0); return isNaN(d.getTime()) ? '?' : ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2); };
        inc.slice(0, 20).forEach(function (i) {
          table.appendChild(window.StructsCards.incident.row({
            at: clock(i.at_ms), planetId: i.planet_id, mode: i.mode || 'incident', fired: i.shots_fired || 0, planned: i.shots_planned || 0,
            attacker: i.attacker_player ? { id: i.attacker_player } : null,
            damage: Math.round((i.projected_damage || 0) * 10) / 10, fireTarget: i.fire_target || null, note: i.note || null,
            advised: !(i.shots_fired > 0) && /advis/i.test(String(i.mode || '') + ' ' + String(i.note || '')),
          }, {
            onClick: function () { add('planet', { id: i.planet_id }); },
            doors: [{ icon: 'icon-combat-log', title: 'Battle log', onClick: function () { add('log', { id: i.planet_id }); } }],
          }));
        });
        host.appendChild(table);
      }).catch(function (e) { fail(host, 'war', e); });
    },
  });

  // ── Wallet (mcp_inventory) ───────────────────────────────────────────────
  T.register('wallet', {
    label: 'Wallet', describe: function (p) { return 'Wallet · ' + (p.id || 'primary'); },
    params: [{ key: 'id', label: 'Player', kind: 'id', kinds: [1], placeholder: 'primary' }],
    cadenceMs: 30000,
    render: function (host, p, ctx) {
      return invoke('mcp_inventory', { player: p.id || 'primary' }).then(function (d) {
        host.innerHTML = '';
        var who = (d && d.player) || {};
        cap(host, (who.name || who.player_id || 'primary') + (who.player_id ? ' · ' + who.player_id : ''));
        var assets = (d && d.assets) || [];
        if (!assets.length) { host.appendChild(H.stateBlock('info', 'No balances read yet.')); return; }
        var table = H.resultTable();
        assets.forEach(function (a) {
          var kind = a.denom === 'ualpha' ? 'alpha' : a.denom === 'ore' ? 'ore' : (/^uguild\./.test(String(a.denom)) ? 'guild' : 'other');
          var qty = kind === 'alpha' ? H.fmtAlpha(a.amount_p != null ? a.amount_p : a.amount) : (kind === 'ore' ? H.fmtOre(a.amount) : H.fmtNum(a.amount));
          table.appendChild(window.StructsCards.asset.row({
            denom: a.denom, name: a.display_name || a.denom, tag: a.guild_tag || null, kind: kind, amount: qty, sendable: a.sendable !== false,
          }, { doors: kind === 'ore'
            // Ore cannot be sent; refining is the only thing to do with it.
            ? [{ icon: 'icon-refine', title: 'Refine ore into alpha', onClick: function () {
                H.confirmModal('Refine this ore?', H.el('div', null, 'It becomes alpha once the proof completes.'), 'Refine', function () {
                  invoke('mcp_action', { action: 'refine', args: {} })
                    .then(function (msg) { Board.stamp && Board.stamp(String(msg).split('\n')[0]); T.refresh(ctx.id, true); })
                    .catch(function (e) { Board.stamp && Board.stamp('refine: ' + e); });
                });
              } }]
            : (a.sendable === false ? [] : [{ icon: 'icon-send-alpha', title: 'Deliver', onClick: function () { add('deliver', {}); } }]) }));
        });
        host.appendChild(table);
      }).catch(function (e) { fail(host, 'inventory', e); });
    },
  });

  // ── System health (mcp_health) ───────────────────────────────────────────
  // ── What to do next ──────────────────────────────────────────────────────
  // The board's default view leads with recommended moves; the Terminal had
  // no equivalent, so a console full of readings never said which one mattered
  // this minute. Every line here is DERIVED from a reading the other cards
  // already show, and opens the card that fixes it — nothing is invented, and
  // a quiet game says so rather than manufacturing advice.
  T.register('next', {
    label: 'What to do next', defaultWidth: 2, single: true,
    describe: function () { return 'What to do next'; }, cadenceMs: 30000,
    render: function (host) {
      var soft = function (cmd, args) { return invoke(cmd, args).catch(function () { return null; }); };
      return Promise.all([
        soft('mcp_energy'), soft('mcp_health'), soft('mcp_tx_snapshot'),
        soft('mcp_infusions'), soft('mcp_raids'), soft('mcp_war_bundle'), soft('mcp_work'),
      ]).then(function (r) {
        var energy = r[0] || {}, health = r[1] || {}, tx = r[2] || {}, fuel = r[3] || {};
        var raids = r[4] || {}, war = r[5] || {}, work = r[6] || {};
        var moves = [];
        var add1 = function (m) { moves.push(m); };

        var brown = ((energy.players) || []).filter(function (x) { return Number(x.margin_pct) <= 0; });
        if (brown.length) add1({ urgency: 'bad', icon: 'sui-icon-energy',
          title: brown.length + ' player' + (brown.length === 1 ? '' : 's') + ' in brownout',
          why: 'their structs switch off until they have power', card: 'halt', label: 'Power margins' });

        var ours = ((raids.raids) || []).filter(function (x) { return x.live && x.our_side === 'defender'; });
        if (ours.length) add1({ urgency: 'bad', icon: 'icon-raid',
          title: ours.length + ' raid' + (ours.length === 1 ? '' : 's') + ' against us, live',
          why: 'ore leaves the planet when the raid resolves', card: 'raids', params: { scope: 'live' }, label: 'Raids' });

        if (health && (health.loops_wedged || 0) > 0) add1({ urgency: 'bad', icon: 'icon-alert',
          title: H.fmtInt(health.loops_wedged) + ' loop' + (health.loops_wedged === 1 ? '' : 's') + ' wedged',
          why: 'the automation has stopped doing that job', card: 'health', label: 'System health' });

        var failed = ((tx.history) || []).filter(function (h) { return h.outcome !== 'success' && h.outcome !== 'skipped'; });
        if (failed.length >= 3) add1({ urgency: 'warn', icon: 'icon-transfers',
          title: H.fmtInt(failed.length) + ' transactions failed recently',
          why: 'the actions they carried never happened', card: 'results', params: { outcome: 'failed' }, label: 'Tx results' });

        var dead = ((fuel.totals) || {}).dead_fuel_ualpha || 0;
        if (dead > 0) add1({ urgency: 'warn', icon: 'sui-icon-alpha-matter',
          title: H.fmtAlpha(dead) + ' of staked alpha earns nothing',
          why: 'it is in a reactor that makes no capacity', card: 'fuel', label: 'Reactor fuel' });

        var go = ((war.targets) || []).filter(function (t) { return !t.blocked_by; });
        if (go.length && ((war.raid) || {}).enabled) add1({ urgency: 'ok', icon: 'icon-raid',
          title: go.length + ' target' + (go.length === 1 ? '' : 's') + ' are GO',
          why: 'scored, unblocked, and holding ore', card: 'targets', label: 'Target board' });

        var hc = work.hash_config || {}, counts = work.counts || {};
        if (hc.enabled === false) add1({ urgency: 'warn', icon: 'icon-computer',
          title: 'Hashing is paused',
          why: 'no mining, refining, building or raiding can complete', card: 'pow', label: 'Proof queue' });
        else if ((counts.waiting || 0) > (hc.max_concurrent || 0) * 4) add1({ urgency: 'warn', icon: 'icon-in-progress',
          title: H.fmtInt(counts.waiting) + ' proofs are waiting',
          why: 'the queue is deeper than the engine can work through', card: 'tasks', label: 'Proof tasks' });

        host.innerHTML = '';
        var RANK = { bad: 0, warn: 1, ok: 2 };
        moves.sort(function (a, b) { return RANK[a.urgency] - RANK[b.urgency]; });
        cap(host, moves.length ? moves.length + ' thing' + (moves.length === 1 ? '' : 's') + ' worth doing' : 'nothing needs you');
        if (!moves.length) { host.appendChild(H.stateBlock('info', 'Every reading this card watches is healthy.')); return; }
        var table = H.resultTable();
        moves.forEach(function (m) {
          table.appendChild(window.StructsCards.row({
            kind: 'move',
            emblem: window.StructsCards.emblem.glyph(m.icon, 'sm', m.urgency === 'bad' ? 'enemy' : m.urgency === 'warn' ? 'warning' : 'player'),
            title: m.title, id: m.label, hideId: true, sub: m.why,
            state: m.urgency === 'bad' ? 'bad' : m.urgency === 'warn' ? 'warn' : 'live',
          }, {
            onClick: function () { add(m.card, m.params || {}); },
            doors: [{ icon: 'icon-link-out', title: 'Open ' + m.label, onClick: function () { add(m.card, m.params || {}); } }],
          }));
        });
        host.appendChild(table);
      }).catch(function (e) { fail(host, 'next moves', e); });
    },
  });

  // The ops feed used to be a card here — `mcp_board_feed` rows in the same
  // shape as the chain tape, with nothing on either card saying which was
  // which. It is now the "Our loops" lane of the rebuilt FEED card
  // (board-terminal.js): one feed, two sources, each row labelled.

  /* ── FLEET: staging, for anyone on the roster ────────────────────────────
   *
   * A raid needs the fleet AT the planet, so `move_fleet` is the verb between
   * reading a target and taking it — and it was primary-only, because
   * `action_move_fleet` reads the fleet id out of GAME_STATE. The fleet you
   * want to stage is usually a worker's.
   *
   * `terminal_fleet_where` is a snapshot read (free), and it reads the FLEET's
   * own location rather than the player's planet, which follows the fleet on
   * arrival and so can never tell you that you are away.
   *
   * The home guard lives in the policy engine and is applied server-side for
   * the primary: leaving home arms our own raid clock and exposes the Command
   * Ship. The card does not restate it — a blocked move comes back saying so.
   */
  T.register('fleet', {
    label: 'Move a fleet', defaultWidth: 1,
    describe: function (p) { return 'Fleet · ' + (p.id || 'primary'); },
    params: [{ key: 'id', label: 'Player', kind: 'id', kinds: [1], placeholder: '1-194' }],
    cadenceMs: 30000,
    render: function (host, p, ctx) {
      return invoke('terminal_fleet_where', { player: p.id || 'primary' }).then(function (d) {
        host.innerHTML = '';
        d = d || {};
        host.appendChild(tiles([
          ['fleet', String(d.fleet_id || '—')],
          ['standing at', String(d.at || '—'), null, d.away ? 'bad' : 'ok'],
          ['home', String(d.home || '—')],
        ]));
        if (d.away) host.appendChild(H.alertLine('Away from home — the raid clock is running and the Command Ship is exposed', 'icon-alert'));
        var slot = H.el('div', 'tm-ticket-slot');
        var doors = [{ label: 'Move', primary: true, onClick: function () {
          slot.innerHTML = '';
          slot.appendChild(ticket({
            cta: 'Move',
            fields: [{ key: 'destination', label: 'Destination', placeholder: '2-…' }],
            confirm: function (v) {
              if (!v.destination) return null;
              return { title: 'Move the fleet?', cta: 'Move', rows: [
                ['Fleet', String(d.fleet_id || '—')],
                ['From', String(d.at || '—')],
                ['To', String(v.destination)],
                ['Signing as', String(d.player || 'primary')],
              ] };
            },
            submit: function (v) {
              if (!v.destination) return Promise.reject('destination required');
              return invoke('terminal_fleet_move', { player: d.player || 'primary', destination: v.destination })
                .then(function (msg) { Board.stamp && Board.stamp(String(msg).split('\n')[0]); });
            },
            done: function () { T.refresh(ctx.id, true); },
          }));
        } }];
        // Retreat is always allowed — the guard never blocks the way back.
        if (d.away && d.home) doors.push({ label: 'Return home', onClick: function () {
          slot.innerHTML = '';
          slot.appendChild(ticket({
            cta: 'Return home',
            confirm: function () {
              return { title: 'Bring the fleet home?', cta: 'Return', rows: [['Fleet', String(d.fleet_id || '—')], ['To', String(d.home)]] };
            },
            submit: function () {
              return invoke('terminal_fleet_move', { player: d.player || 'primary', destination: d.home })
                .then(function (msg) { Board.stamp && Board.stamp(String(msg).split('\n')[0]); });
            },
            done: function () { T.refresh(ctx.id, true); },
          }));
        } });
        host.appendChild(doorRow(doors));
        host.appendChild(slot);
      }).catch(function (e) { fail(host, 'fleet', e); });
    },
  });
  T.register('health', {
    label: 'System health', describe: function () { return 'System health'; }, cadenceMs: 15000,
    render: function (host) {
      return invoke('mcp_health').then(function (h) {
        host.innerHTML = '';
        if (Board.healthTiles) host.appendChild(Board.healthTiles(h));
        else host.appendChild(H.row('Status', String((h && h.status) || 'unknown')));
        // "Healthy" with no detail hides WHICH part was unwell, and the feed
        // is where the watchdog says what it did about it.
        var up = function (v) { return v === 'ok' || v === 'up' || v === true; };
        [['Signing bridge', h && h.signing_bridge], ['Grass stream', h && h.grass], ['Guild auth', h && h.guild_auth]].forEach(function (r) {
          if (r[1] == null || r[1] === '') return;
          host.appendChild(H.row(r[0], String(r[1]), up(r[1]) ? 'icon-success' : 'icon-alert'));
        });
        if (h && (h.loops_overdue || h.loops_wedged)) {
          host.appendChild(H.alertLine(H.fmtInt(h.loops_overdue || 0) + ' loops overdue · ' + H.fmtInt(h.loops_wedged || 0) + ' wedged', 'icon-alert'));
        }
        /* `resync` is the verb for the state this card is FOR: a stream that
         * has stopped, a bridge that has gone quiet. Soft re-syncs game state
         * and reconnects the event stream; hard reloads the page, which drops
         * anything unsaved, so it is the one behind the ticket. */
        var slot = H.el('div', 'tm-ticket-slot');
        host.appendChild(doorRow([
          { label: 'What the watchdog did', onClick: function () { add('feed', {}); } },
          { label: 'Re-sync', onClick: function () {
            slot.innerHTML = '';
            slot.appendChild(ticket({
              cta: 'Re-sync',
              fields: [{ key: 'hard', label: 'Depth', kind: 'choice',
                options: [{ value: 'soft', label: 'soft · re-sync state and reconnect' }, { value: 'hard', label: 'hard · reload the page' }] }],
              confirm: function (v) {
                return { title: 'Re-sync?', cta: 'Re-sync', rows: [
                  ['Depth', v.hard === 'hard' ? 'hard' : 'soft'],
                  ['Effect', v.hard === 'hard' ? 'reloads the page' : 're-syncs game state and reconnects the stream'],
                ] };
              },
              submit: function (v) {
                return invoke('mcp_action', { action: 'resync', args: { hard: v.hard === 'hard' } })
                  .then(function (msg) { Board.stamp && Board.stamp(String(msg).split('\n')[0]); });
              },
            }));
          } },
        ]));
        host.appendChild(slot);
      }).catch(function (e) { fail(host, 'health', e); });
    },
  });

  /* ── Deliver ──────────────────────────────────────────────────────────────
   *
   * Was `transfer.html` in an iframe, and every problem it had was that one
   * problem: a whole DOCUMENT pretending to be a card. It carried its own
   * `.sui-panel`, its own nav bar, its own close button and the game's
   * menu-page scaler, so the card drew a frame around a frame, the header sat
   * a screen's border too low, the type came out at 2× past 1152px, and the
   * panel tools the card owns had nowhere to live. Patching each of those in
   * `embed.css` was treating symptoms of the embed itself.
   *
   * So: a card, drawn here, from the same parts every other card uses.
   *
   * The shape keeps the one genuinely good idea the old window had — a
   * payment names two PEOPLE, and seeing the recipient's face and id is what
   * catches a mis-send before it is signed, which an address never does. The
   * amount is the only number you are deciding, so it is the only number
   * drawn large; balance, what you would be left with, and which queue signs
   * it are facts beside it.
   *
   * `transfer.html` stays: Comms still opens it as its own window, which is a
   * window, and there it is right.
   */
  T.register('deliver', {
    label: 'Deliver', cadenceMs: 0,
    describe: function (p) { return 'Deliver' + (p && p.to ? ' · ' + (p.name || p.to) : ''); },
    params: [{ key: 'to', label: 'Pay whom', kind: 'id', kinds: [1], placeholder: '1-61' }],
    render: function (host, p, ctx) {
      var S = { from: null, picking: false, assets: [], denom: null, base: 0, unit: null,
                to: null, preview: null, timer: null, busy: false };
      host.innerHTML = '';
      /* One element owns the card's width so both halves of the layout can ask
       * about it — the parties stack and the amount's caption drops under its
       * control at a one-wide card, and both go back on one line at two. The
       * CARD's width, not the viewport's: this can be one of three columns or
       * a popped-out window, and the viewport says nothing about either. */
      var root = H.el('div', 'deliver');
      var parties = H.el('div', 'deliver-parties');
      var amountHost = H.el('div', 'deliver-amount-host');
      var facts = H.el('div', 'deliver-facts');
      var note = H.el('div', 'deliver-note');
      var actions = H.el('div', 'deliver-actions');
      /* Balance and Send are one line, not two. They are the same thought —
       * what you have, and the button that spends it — and stacking them put
       * a band of empty card between a figure and the control it governs. */
      var bar = H.el('div', 'deliver-bar');
      bar.appendChild(facts);
      bar.appendChild(actions);
      [parties, amountHost, note, bar].forEach(function (n) { root.appendChild(n); });
      host.appendChild(root);

      function asset() {
        for (var i = 0; i < S.assets.length; i++) if (S.assets[i].denom === S.denom) return S.assets[i];
        return null;
      }
      /* Alpha rides the shared ladder so a figure copied off any other card
       * pastes back in. A guild token has only the two rungs its guild named. */
      function rungs(a) {
        if (!a || a.denom === 'ualpha') return null;
        var out = [], exp = Number(a.exponent) || 0;
        if (exp > 0 && a.display_name) out.push({ label: a.display_name, mul: Math.pow(10, exp) });
        out.push({ label: a.base_name || a.denom, mul: 1 });
        return out;
      }
      function assetName(a) { return a ? (a.denom === 'ualpha' ? 'alpha' : (a.display_name || a.denom)) : ''; }
      /* `amount` is the FLOORED display figure; `amount_p` is the precise base
       * one. Spending the first would send whole Alpha when the player holds
       * 40230.7, and MAX off it leaves the remainder stranded. */
      function baseOf(a) { return Number(a && a.amount_p != null ? a.amount_p : (a && a.amount) || 0) || 0; }

      // ── The two parties ──────────────────────────────────────────────────
      function person(role, o, extra, onClear) {
        var box = H.el('div', 'deliver-party sui-screen');
        box.appendChild(H.el('div', 'fstat-l', role));
        var line = PC() && PC().parts.personLine
          ? PC().parts.personLine({ id: o.id, name: o.name, tag: o.tag, pfp: o.pfp }, {})
          : H.el('div', null, String(o.name || o.id || ''));
        if (line) box.appendChild(line);
        /* One tiny footer carrying both. An address is lowercase bech32 —
         * `fstat-l` upper-cases, which made structs1zpta…dk4q6s read as
         * something you could not paste back — and the link takes its size by
         * INHERITANCE, because SUI's `a:link` out-specifies any type class
         * put on the anchor itself. */
        var foot = H.el('div', 'deliver-foot sui-text-tiny');
        if (extra) foot.appendChild(H.el('span', 'deliver-addr', extra));
        if (onClear) {
          var a = H.el('a', 'deliver-clear', 'change');
          a.href = 'javascript:void(0)';
          a.addEventListener('click', onClear);
          foot.appendChild(a);
        }
        if (foot.childNodes.length) box.appendChild(foot);
        return box;
      }
      /* ── One picker, both sides ────────────────────────────────────────────
       *
       * The slot IS the search: an empty party box with no way to find anyone
       * was the old window's dead end, and it was only ever fixed for the
       * recipient — the payer was hardcoded to the primary, so an account that
       * holds the Alpha could not be the one to spend it.
       *
       * What differs between the two sides is the CANDIDATE SET, not the
       * interaction:
       *
       *   TO   — the whole galaxy (`mcp_player_search`). Anyone can be paid.
       *   FROM — the roster only (`mcp_roster`). A payer is an account we hold
       *          a key to; offering the galaxy here would list payers nobody
       *          at this desk can sign as, and every pick would fail at the
       *          signer instead of at the picker.
       *
       * So `find` is the only thing the two calls disagree about. */
      function picker(role, opts) {
        var box = H.el('div', 'deliver-party sui-screen');
        box.appendChild(H.el('div', 'fstat-l', role));
        var input = H.textBox('', opts.placeholder, function () {});
        input.setAttribute('autocomplete', 'off');
        box.appendChild(H.field('', input));
        var hits = H.el('div', 'deliver-hits');
        box.appendChild(hits);
        var timer = null;
        /* An id is not a name, and half an id is neither.
         *
         * Every keystroke went to the guild API's name search, so typing
         * `1-61` sent `1-` — which that API rejects — and the card printed its
         * 400 verbatim: a URL, a JSON body and the words "this value is not
         * valid", upper-cased across six lines, in place of the answer. A
         * player id is resolved here, and a PARTIAL one is not a question
         * worth asking anyone. */
        function idish(q) { return /^\d+-/.test(q); }
        function whole(q) { return /^\d+-\d+$/.test(q); }
        function say(text) { hits.innerHTML = ''; if (text) hits.appendChild(H.el('div', 'fstat-l', text)); }
        function draw(list, empty) {
          hits.innerHTML = '';
          list.slice(0, 5).forEach(function (r) {
            var row = PC() && PC().parts.personLine
              ? PC().parts.personLine({ id: r.id, name: r.name, tag: r.tag, pfp: r.pfp },
                  { cls: 'deliver-hit', onClick: function () { opts.pick(r); } })
              : null;
            if (row) hits.appendChild(row);
          });
          if (!hits.childNodes.length) say(empty);
        }
        function run() {
          var q = String(input.value || '').trim();
          if (opts.enterResolves && whole(q)) { say('press enter for ' + q); return; }
          if (opts.enterResolves && (idish(q) || q.length < 2)) { say(''); return; }
          opts.find(q).then(function (list) {
            if (String(input.value || '').trim() !== q) return;   // a later keystroke owns the box
            draw(list, q ? opts.empty : '');
          // Never the raw failure: it is a wall of URL and JSON where the
          // answer goes, and there is nothing in it the player can act on.
          }).catch(function () { say('search unavailable'); });
        }
        input.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(run, 250); });
        /* A whole id needs no search: it is already the answer. Only the
         * recipient side takes one — a payer typed as a bare id we do not hold
         * a key to is a pick that can only fail later. */
        if (opts.enterResolves) {
          input.addEventListener('keydown', function (e) {
            if (e.key !== 'Enter') return;
            var v = String(input.value || '').trim();
            if (whole(v)) { e.preventDefault(); opts.pick({ id: v }); }
          });
        }
        /* The roster opens showing its richest accounts rather than an empty
         * box: "who can afford this" is the actual question a payer picker is
         * asked, and a list of eight hundred callsigns nobody can recall is
         * not a list you type your way into blind. */
        if (opts.openWith) opts.openWith().then(function (l) { draw(l, ''); }).catch(function () {});
        return box;
      }

      /* An id is not a name, and half an id is neither.
       *
       * Every keystroke used to go to the guild API's name search, so typing
       * `1-61` sent `1-` — which that API rejects — and the card printed its
       * 400 verbatim: a URL, a JSON body and the words "this value is not
       * valid", upper-cased across six lines, in place of the answer. A player
       * id is resolved by Enter, and a PARTIAL one is not a question worth
       * asking anyone. */
      function findGalaxy(q) {
        return invoke('mcp_player_search', { query: q }).then(function (res) {
          return ((res && (res.results || res.players)) || res || []).map(function (r) {
            return { id: r.player_id, name: r.name || r.username, tag: r.guild_tag, pfp: r.pfp || r.pfp_attrs };
          });
        });
      }
      /* The roster is already cached and already whole, so it is filtered HERE
       * rather than asked of a server — an eight-hundred-row list is a
       * substring match, not a round trip per keystroke. */
      function rosterRows(q, byWealth) {
        return invoke('mcp_roster', { refreshIfOlderMs: 120000 }).then(function (snap) {
          var rows = (snap && snap.rows) || [];
          var needle = String(q || '').trim().toLowerCase();
          if (needle) {
            rows = rows.filter(function (r) {
              return String(r.player_id || '').toLowerCase().indexOf(needle) >= 0
                || String(r.name || '').toLowerCase().indexOf(needle) >= 0;
            });
          }
          if (byWealth) rows = rows.slice().sort(function (a, b) { return (b.alpha_ualpha || 0) - (a.alpha_ualpha || 0); });
          return rows.map(function (r) {
            return {
              // `who` is what the signer is asked for: the primary is a ROLE,
              // and a vplayer is its player id. `resolve_player` reads both.
              who: r.role === 'primary' ? 'primary' : r.player_id,
              id: r.player_id, name: r.name, pfp: r.pfp_attrs, tag: null,
            };
          });
        });
      }
      /* Switching payer invalidates everything downstream: a different account
       * holds different assets, so the chosen denom, the typed amount and the
       * preview are all answers to a question that is no longer being asked. */
      function choosePayer(row) {
        S.picking = false;
        S.from = { who: row.who, id: row.id, name: row.name, pfp: row.pfp, tag: row.tag, address: null };
        S.denom = null; S.base = 0; S.unit = null; S.preview = null;
        setNote('', '');
        paint();
        load().then(function () { schedule(); });
      }

      function choose(playerId, name, pfp, tag) {
        S.to = { id: playerId, name: name, pfp: pfp, tag: tag, address: null };
        paint();
        invoke('matrix_resolve_payable', { playerId: playerId }).then(function (intent) {
          if (!intent || !intent.to) return;
          /* The resolver's `name` is the address book's, and falls back to
           * the id — which must not beat a real name the caller already had
           * ("TO 1-61 #1-61" on a card that knew JPEG). */
          var known = intent.name && intent.name !== (intent.playerId || playerId) ? intent.name : null;
          S.to = { id: intent.playerId || playerId, name: name || known, pfp: pfp, tag: tag, address: intent.to };
          paint(); schedule();
        }).catch(function () {
          S.preview = null;
          setNote('error', 'no payable address for ' + playerId);
          paintActions();
        });
      }

      function setNote(kind, text) {
        note.innerHTML = '';
        if (text) note.appendChild(H.stateBlock(kind, text));
      }

      // ── Preview ──────────────────────────────────────────────────────────
      function schedule() {
        if (S.timer) clearTimeout(S.timer);
        S.timer = setTimeout(preview, 250);
      }
      function preview() {
        if (!S.to || !S.to.address || !S.denom || !S.base) { S.preview = null; paintFacts(); return; }
        invoke('mcp_transfer_preview', { from: (S.from && S.from.who) || 'primary', to: S.to.address, denom: S.denom, amount: S.base })
          .then(function (pv) {
            S.preview = pv;
            setNote(pv && pv.ok ? '' : 'error', pv && pv.problems && pv.problems.length ? pv.problems.join(' · ') : '');
            paintFacts();
          })
          .catch(function (e) { S.preview = null; setNote('error', String(e)); paintFacts(); });
      }

      function send() {
        if (S.busy || !S.preview || !S.preview.ok) return;
        S.busy = true; paintActions();
        invoke('mcp_transfer_execute', { from: (S.from && S.from.who) || 'primary', to: S.to.address, denom: S.denom, amount: S.base })
          .then(function () {
            S.busy = false; S.base = 0; S.preview = null;
            setNote('ok', 'sent to ' + (S.to.name || S.to.id));
            return load();
          })
          .catch(function (e) { S.busy = false; setNote('error', String(e)); paintActions(); });
      }

      // ── Paint ────────────────────────────────────────────────────────────
      function paintFacts() {
        facts.innerHTML = '';
        var a = asset();
        if (!a) return;
        var bal = baseOf(a);
        var f = function (label, value) {
          /* Supporting facts, not the decision: the amount is the one figure
           * at reading size, and "primary signing queue" at 16px shouted over
           * it. */
          var w = H.el('span', 'deliver-fact');
          w.appendChild(H.el('span', 'fstat-l', label));
          w.appendChild(H.el('b', 'sui-text-tiny', value));
          facts.appendChild(w);
        };
        f('balance', H.fmtAmountIn(a, bal));
        if (S.base) f('after', H.fmtAmountIn(a, Math.max(0, bal - S.base)));
        if (S.preview && S.preview.route) f('route', S.preview.route);
        paintActions();
      }
      function paintActions() {
        actions.innerHTML = '';
        var ready = !!(S.preview && S.preview.ok) && !S.busy;
        var a = H.el('a', 'sui-screen-btn ' + (ready ? 'sui-mod-primary' : 'sui-mod-secondary'));
        a.href = 'javascript:void(0)';
        a.appendChild(H.el('i', 'icon-send-alpha'));
        a.appendChild(H.el('span', null, S.busy ? ' Sending…' : ' Send'));
        /* The QUANTITY escapes the button's face. `sui-screen-btn` is set in
         * ExtremeHazard, which has no lowercase — so a send of 1μg read
         * "SEND 1MG" on the one control whose whole job is to state, exactly,
         * what is about to be signed. Unit strings are case-bearing (μg, mg,
         * Kg, Tg are four different amounts) and belong in DirectiveZero. */
        if (!S.busy && S.base && asset()) {
          a.appendChild(document.createTextNode(' '));
          a.appendChild(H.el('span', 'deliver-qty', H.fmtAmountIn(asset(), S.base)));
        }
        if (!ready) a.classList.add('deliver-off');
        else a.addEventListener('click', send);
        actions.appendChild(a);
      }
      function paintAmount() {
        amountHost.innerHTML = '';
        var a = asset();
        // Nothing sendable is a STATE, not an empty card with a dead button.
        if (!a) { amountHost.appendChild(H.stateBlock('info', 'nothing sendable in this wallet')); return; }
        var opts = {
          kind: 'alpha', rungs: rungs(a), base: S.base, max: baseOf(a),
          onChange: function (base, unit) { S.base = base; S.unit = unit; paintFacts(); schedule(); },
        };
        /* WHICH asset first, then how much of it. Always shown, even holding
         * nothing but Alpha: the list IS the answer to "what can I send", and
         * a control that appears only once you happen to hold a second token
         * is one nobody knows exists. Alpha sorts first and is the default. */
        var sel = H.selectBox(S.denom, S.assets.map(function (x) {
          return { value: x.denom, label: assetName(x) + ' · ' + H.fmtAmountIn(x, baseOf(x)) };
        }), function (dn) { S.denom = dn; S.unit = null; S.base = 0; paintAmount(); paintFacts(); schedule(); });
        amountHost.appendChild(H.field('Asset', sel));
        if (S.unit) opts.unit = S.unit;
        var af = H.amountField('Amount', opts);
        var input = af.querySelector('.amount-input');
        if (input) input.classList.add('sui-text-paragraph');
        amountHost.appendChild(af);
      }
      function paint() {
        parties.innerHTML = '';
        parties.appendChild(S.picking
          ? picker('FROM', {
              placeholder: 'callsign or 1-61',
              empty: 'nobody on the roster by that name',
              find: function (q) { return rosterRows(q, false); },
              openWith: function () { return rosterRows('', true); },
              pick: choosePayer,
            })
          : person('FROM', S.from || { id: 'primary' },
              S.from && S.from.address ? shortAddr(S.from.address) : null,
              function () { S.picking = true; paint(); }));
        /* `icon-arrow`, not `icon-arrow-right`: the latter is not in the icon
         * font, so this drew an empty box between the two parties and the
         * direction of the payment was carried by the labels alone. */
        var ar = H.el('div', 'deliver-arrow');
        ar.appendChild(H.el('i', 'sui-icon sui-icon-sm icon-arrow'));
        parties.appendChild(ar);
        parties.appendChild(S.to
          ? person('TO', S.to, S.to.address ? shortAddr(S.to.address) : 'resolving…',
              function () { S.to = null; S.preview = null; setNote('', ''); paint(); paintFacts(); })
          : picker('TO', {
              placeholder: 'name or 1-61',
              empty: 'no one by that name',
              enterResolves: true,
              find: findGalaxy,
              pick: function (r) { choose(r.id, r.name, r.pfp, r.tag); },
            }));
        paintAmount();
        paintFacts();
      }
      function shortAddr(a) {
        var s = String(a || '');
        return s.length > 20 ? s.slice(0, 12) + '…' + s.slice(-6) : s;
      }

      function load() {
        // Whoever is paying — the primary until somebody picks otherwise.
        var who = (S.from && S.from.who) || 'primary';
        return invoke('mcp_inventory', { player: who }).then(function (d) {
          /* `mcp_inventory` names the player `player_id`, the player card wants
           * `id`. Left unmapped the FROM side drew nothing at all — a payment
           * screen naming one of its two parties. The address comes from here
           * too, which is why a freshly picked payer is re-loaded rather than
           * trusted from the roster row: the roster carries no address. */
          var me = d && d.player;
          if (me) {
            /* "primary" is the ROLE this account plays, not what it is called.
             * Until the game window has reported a callsign the server still
             * answers with the label, and drawing it as the payer's name put a
             * person called "primary" on one side of the payment. An unnamed
             * player is shown by id, which `personLine` already does. */
            var nm = me.name && String(me.name) !== 'primary' ? me.name : null;
            S.from = { who: who, id: me.player_id || me.id, name: nm,
                       pfp: me.pfp || me.pfp_attrs, tag: me.guild_tag, address: me.address };
          }
          /* Whatever the SERVER says may leave a wallet, not a list kept here:
           * ore is not a bank asset at all and staking states are not
           * balances, and the two must never disagree. */
          S.assets = ((d && d.assets) || []).filter(function (x) { return x.sendable && baseOf(x) > 0; });
          S.assets.sort(function (x, y) {
            if (x.denom === 'ualpha') return -1;
            if (y.denom === 'ualpha') return 1;
            return String(x.display_name || x.denom).localeCompare(y.display_name || y.denom);
          });
          if (!asset()) { S.denom = S.assets.length ? S.assets[0].denom : null; S.unit = null; }
          paint();
        });
      }

      return load().then(function () {
        if (p && p.to) choose(String(p.to), p.name ? String(p.name) : null, null, null);
        // Handed a recipient by Comms: the same claim the window made.
        else invoke('matrix_take_pending_transfer').then(function (intent) {
          if (intent && intent.playerId) choose(intent.playerId, intent.name, intent.pfp_attrs, null);
        }).catch(function () {});
      });
    },
  });

})();
