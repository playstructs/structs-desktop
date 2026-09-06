// Raid view — the battle log: every planet_activity row for this planet.
//
// The deliberate exception to map parity: the game never shows a planet's
// whole recorded history in one place, and for a spectator that history IS
// the story. A busy planet writes thousands of rows and most of them are
// bookkeeping, so the log is built to be SKIMMED: grouped by day, weighted by
// kind, and filtered down to the combat story by default.
//
// Extracted from raidview.js (2026-09-06). Collaborators arrive as a context
// so scripts/harness-tests/raidlog.test.mjs can drive it with a stub
// `__TAURI__` and no window boot:
//
//   window.RaidLog({ el, humanStatus, state })
//     → { logState, LOG_LIMIT, LOG_KINDS, logFilter, logKey, logKind, logLabel, dayLabel,
//         applyLog, refreshLog, renderLogFilters, renderLog, renderLogError }
(function () {
  'use strict';
  window.RaidLog = function (ctx) {
    var el = ctx.el, humanStatus = ctx.humanStatus, state = ctx.state;

    var logState = { rows: [], open: false, loading: false, pending: false, planetId: null };

    /** How many log rows are kept in memory, for both the initial fetch and the
     * live stream's ceiling. */
    var LOG_LIMIT = 200;

    /** Newest rows off the GRASS stream, prepended in place.
     *
     * The log used to load exactly once — on open, or when a followed fleet
     * re-targeted — so a window left open showed a frozen log while the map
     * animated live next to it. Only a reload caught it up.
     *
     * Rows arrive oldest-first (see `collect_log_rows`), so unshifting each in
     * turn leaves the newest on top, which is the order `mcp_raid_log` serves.
     * Kept even while the panel is collapsed: opening it should show what
     * happened, not restart from the moment it was opened.
     */
    /** Identity of a log row, for the overlap check below. */
    function logKey(r) {
      return (r.date || '') + ' ' + (r.time || '') + '|' + (r.category || '') + '|' + (r.detail || '');
    }

    function applyLog(payload) {
      if (!state().snapshot) return;
      if (payload.generation !== state().generation) return;   // stale planet
      var rows = payload.rows || [];
      if (!rows.length) return;
      // The initial fetch reads history up to NOW while the stream cursor starts
      // 30s back, so the first poll after opening the log re-delivers rows the
      // fetch already has. Check the newest slice rather than keeping a set: the
      // overlap is bounded by that backfill window, so it is always near the top.
      var recent = {};
      logState.rows.slice(0, 60).forEach(function (r) { recent[logKey(r)] = true; });
      rows.forEach(function (r) {
        if (recent[logKey(r)]) return;
        logState.rows.unshift(r);
      });
      // Same ceiling the initial fetch uses, so memory can't creep on a long watch.
      if (logState.rows.length > LOG_LIMIT) logState.rows.length = LOG_LIMIT;
      if (logState.open) renderLog();
    }

    function refreshLog() {
      var planetId = state().snapshot && state().snapshot.planet_id;
      // Opened before the first snapshot arrived: remember that we still owe a
      // load, so the snapshot can trigger it rather than leaving the panel
      // permanently claiming there is no activity.
      if (!planetId) { logState.pending = true; return; }
      if (logState.loading || !window.__TAURI__) return;
      logState.pending = false;
      logState.loading = true;
      window.__TAURI__.core.invoke('mcp_raid_log', { planetId: planetId, limit: LOG_LIMIT })
        .then(function (d) {
          logState.rows = (d && d.rows) || [];
          logState.planetId = planetId;
          renderLog();
        })
        .catch(function (e) { renderLogError(String(e)); })
        .then(function () { logState.loading = false; });
    }

    /* ── Battle log ──────────────────────────────────────────────────────────
       A busy planet writes thousands of rows and most of them are bookkeeping —
       72k `struct_status` and 32k `struct_health` across production against
       1.8k attacks. So the log is built to be SKIMMED, not read:

         · rows are grouped under the day they happened. They arrive strictly
           newest-first, but a bare clock made that look shuffled the moment the
           list crossed midnight (12:51, then 14:46, then 19:28 — three days);
         · each row carries a KIND from the backend, and the kinds have distinct
           weight, so an attack does not look like a status flag flipping;
         · a filter strip drops the routine kinds entirely, which is the only
           way the combat story is legible on a planet that has been built on. */

    /** Per-kind presentation. Order here is the order of the filter strip. */
    var LOG_KINDS = [
      { key: 'combat',   label: 'Combat',   tone: 'rv-bad' },
      { key: 'defense',  label: 'Defense',  tone: 'rv-warn' },
      { key: 'movement', label: 'Movement', tone: '' },
      { key: 'economy',  label: 'Economy',  tone: '' },
      { key: 'state',    label: 'State',    tone: 'rv-dim' }
    ];
    var LOG_TONE = {};
    LOG_KINDS.forEach(function (k) { LOG_TONE[k.key] = k.tone; });

    /** Which kinds are showing. Combat and defense are the story; the rest are
     * available but off, so opening the log lands on something worth reading. */
    var logFilter = { combat: true, defense: true, movement: true, economy: false, state: false };

    /** One word per category. The chain's names are long and mostly prefix
     * ("struct_block_ore_refine_start"), which wrapped the label column and made
     * every row a different height — the single worst thing for skimming. The
     * detail line already names the struct, so the label only has to say what
     * KIND of thing happened. */
    var LOG_LABEL = {
      struct_attack: 'attack',
      raid_status: 'raid',
      shield_change: 'shield',
      block_raid_start: 'raidable',
      struct_defense_add: 'defend',
      struct_defense_remove: 'undefend',
      fleet_arrive: 'arrive',
      fleet_depart: 'depart',
      struct_move: 'move',
      struct_block_build_start: 'build',
      struct_block_ore_mine_start: 'mine',
      struct_block_ore_refine_start: 'refine',
      struct_status: 'status',
      struct_health: 'health'
    };

    /** Label for a category — the short form when we know it, otherwise the
     * humanised chain name so a new category is still readable on day one. */
    function logLabel(category) {
      return LOG_LABEL[category] || humanStatus(category || '');
    }

    /** A row's kind, tolerating an older backend that did not send one. */
    function logKind(r) {
      if (r.kind) return r.kind;
      if (r.category === 'struct_attack' || r.category === 'raid_status') return 'combat';
      return 'state';
    }

    /** "2026-07-31" → "TODAY" / "YESTERDAY" / "WED 30 JUL". Relative labels are
     * worth the arithmetic: on a live raid every row is today, and a date stamp
     * on all of them is noise. */
    function dayLabel(iso) {
      if (!iso) return '';
      var parts = iso.split('-');
      if (parts.length !== 3) return iso;
      var d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
      var today = new Date();
      today.setHours(0, 0, 0, 0);
      var days = Math.round((today - d) / 86400000);
      if (days === 0) return 'TODAY';
      if (days === 1) return 'YESTERDAY';
      var DAY = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
      var MON = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
      return DAY[d.getDay()] + ' ' + d.getDate() + ' ' + MON[d.getMonth()]
        + (d.getFullYear() !== today.getFullYear() ? ' ' + d.getFullYear() : '');
    }

    /** The filter strip, rebuilt whenever counts change so each chip can show
     * how much it is hiding — a disabled filter with 4,000 rows behind it should
     * say so rather than leaving the operator wondering where the log went. */
    function renderLogFilters() {
      var host = document.getElementById('rv-log-filters');
      if (!host) return;
      var counts = {};
      logState.rows.forEach(function (r) {
        var k = logKind(r);
        counts[k] = (counts[k] || 0) + 1;
      });
      host.innerHTML = '';
      LOG_KINDS.forEach(function (k) {
        if (!counts[k.key]) return;                 // nothing of this kind here
        var chip = el('a', 'rv-log-chip sui-text-label' + (logFilter[k.key] ? ' rv-on' : ''));
        chip.href = 'javascript: void(0)';
        chip.appendChild(el('span', k.tone || null, k.label));
        chip.appendChild(el('span', 'rv-log-chip-n', String(counts[k.key])));
        chip.addEventListener('click', function () {
          logFilter[k.key] = !logFilter[k.key];
          renderLog();
        });
        host.appendChild(chip);
      });
    }

    function renderLog() {
      var body = document.getElementById('rv-log-body');
      var count = document.getElementById('rv-log-count');
      if (!body) return;
      renderLogFilters();
      body.innerHTML = '';
      if (!logState.rows.length) {
        if (count) count.textContent = '';
        body.appendChild(el('div', 'rv-log-empty sui-text-tiny', 'No recorded activity for this planet yet.'));
        return;
      }
      var shown = logState.rows.filter(function (r) { return logFilter[logKind(r)]; });
      // The count reports what is ON SCREEN over what was fetched — "12/200"
      // makes the filter's effect obvious without reading the chips.
      if (count) {
        count.textContent = shown.length === logState.rows.length
          ? String(logState.rows.length)
          : shown.length + '/' + logState.rows.length;
      }
      if (!shown.length) {
        body.appendChild(el('div', 'rv-log-empty sui-text-tiny',
          'Nothing in the selected categories. ' + logState.rows.length + ' rows hidden.'));
        return;
      }
      var day = null;
      shown.forEach(function (r) {
        if (r.date !== day) {
          day = r.date;
          body.appendChild(el('div', 'rv-log-day sui-text-label', dayLabel(day)));
        }
        var kind = logKind(r);
        var row = el('div', 'rv-log-row rv-k-' + kind + (LOG_TONE[kind] ? ' ' + LOG_TONE[kind] : ''));
        row.appendChild(el('div', 'rv-log-t', r.time || ''));
        row.appendChild(el('div', 'rv-log-cat sui-text-label', logLabel(r.category)));
        row.appendChild(el('div', 'rv-log-d', r.detail || ''));
        body.appendChild(row);
      });
    }

    function renderLogError(msg) {
      var body = document.getElementById('rv-log-body');
      if (body) { body.innerHTML = ''; body.appendChild(el('div', 'rv-log-empty', 'log unavailable: ' + msg)); }
    }

    return {
      logState: logState, LOG_LIMIT: LOG_LIMIT, LOG_KINDS: LOG_KINDS, logFilter: logFilter, logKey: logKey,
      logKind: logKind, logLabel: logLabel, dayLabel: dayLabel, applyLog: applyLog, refreshLog: refreshLog,
      renderLogFilters: renderLogFilters, renderLog: renderLog, renderLogError: renderLogError,
    };
  };
})();
