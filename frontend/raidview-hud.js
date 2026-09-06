// Raid view — the HUD: the game's four panels driven from the snapshot.
// Top-left energy, top-right the spectated planet's shield and ore (the
// game's ENEMY-themed panel, which is what this planet is to a spectator),
// bottom-left the defender, bottom-right the raider. Plus the portrait
// painter with its change guard (an unguarded repaint swaps five <img>
// elements several times a second and the faces flicker), the 5-chunk
// battery through ChargeCalculator's own ladder, and the small formatters.
//
// Extracted from raidview.js (2026-09-06). Collaborators arrive as a context
// so scripts/harness-tests/raidhud.test.mjs can drive it with a stub
// StructsPfp and no window boot:
//
//   window.RaidHud({ state, target, chat, paintComposerIdentity })
//     → { renderHeader, renderSide, paintPfp, paintBattery, whoLine, chargeLevel,
//         CHARGE_THRESHOLDS, fmtAge, humanStatus, fmtNum, setText }
(function () {
  'use strict';
  window.RaidHud = function (ctx) {
    var state = ctx.state, target = ctx.target, chat = ctx.chat, paintComposerIdentity = ctx.paintComposerIdentity;



    /* Drive the game's HUD panels from the snapshot. The mapping is the game's
     * own: top-left = energy, top-right = the spectated planet's shield + ore
     * (the game's ENEMY-themed panel, which is what this planet is to a
     * spectator), bottom-left = defender, bottom-right = raider. */
    function renderHeader() {
      var snap = state().snapshot;
      var where = target()
        ? (target().kind === 'fleet'
            ? 'FLEET ' + target().id + (snap ? ' · AT PLANET ' + snap.planet_id : ' · IN TRANSIT')
            : 'PLANET ' + target().id)
        : '—';
      setText('rv-where', where);

      // Freshness is the NEWEST of the two signals, not whichever exists.
      // Taking lastEventMs first meant a planet that had one stream event and
      // then went quiet reported "4m ago" forever while 20-second snapshots kept
      // arriving — the feed was healthy and the HUD said it was dead.
      // A missing stamp is 0, and `Date.now() - 0` renders the whole Unix epoch
      // as an age ("17854432765s ago"), so treat that as unknown instead.
      var stamp = Math.max(state().lastEventMs || 0, (snap && snap.fetched_at_ms) || 0);
      var age = stamp > 0 ? Date.now() - stamp : null;
      var live = document.getElementById('rv-live');
      if (live) {
        live.textContent = !snap ? 'connecting'
          : age == null ? 'live'
          : age < 30000 ? 'live' : fmtAge(age);
        live.className = 'rv-live-dot'
          + (age == null || age < 30000 ? '' : (age < 120000 ? ' stale' : ' dead'));
      }
      if (!snap) return;

      // Shield: the game shows the value beside a shield glyph whose state is
      // up/down. `planetaryShield` arrives on the live stream ahead of the next
      // snapshot, so prefer it.
      var shield = state().planetaryShield || snap.planetary_shield || 0;
      // The game's own shield art and vocabulary: secure / vulnerable /
      // breached, drawn from img/non_standard_icons. The `_raid_enemy` suffix is
      // the variant the game uses for a planet that is not yours — which, to a
      // spectator, is always the case.
      var status = state().raidStatus || snap.raid_status;
      var shieldState = shield <= 0 ? 'breached'
        : (status === 'shieldsVulnerable' ? 'vulnerable' : 'secure');
      // The NUMBER only appears while the shield is vulnerable. Secure, its
      // exact value tells a spectator nothing actionable and reads as a health
      // bar it is not (shield does not predict a raid's outcome — it is the
      // proof's difficulty range, a timer). Breached, it is zero by definition.
      // In both of those the glyph alone carries the whole state().
      setText('rv-shield', shieldState === 'vulnerable' ? fmtNum(shield) : '');
      var icon = document.getElementById('rv-shield-icon');
      if (icon && icon.dataset.shieldState !== shieldState) {
        icon.dataset.shieldState = shieldState;
        icon.innerHTML = '<img src="img/non_standard_icons/shield_' + shieldState
          + '_raid_enemy.png" alt="' + shieldState + '" />';
      }
      var shieldRes = document.getElementById('rv-shield-res');
      if (shieldRes) {
        shieldRes.setAttribute('data-sui-tooltip',
          'Planetary shield ' + fmtNum(shield)
          + (shield > 0 ? ' — raids cannot seize until it falls' : ' — DOWN, the planet is vulnerable')
          + (status ? '\nRaid: ' + humanStatus(status) : ''));
      }

      setText('rv-ore', snap.stored_ore == null ? '—' : fmtNum(snap.stored_ore));
      setText('rv-energy', snap.owner_energy || '—');

      // Defender (bottom-left) and raider (bottom-right).
      // The viewer's charge is a fact about THIS player, not the raid, but it
      // arrives on the same snapshot and changes on the same clock.
      if (snap.viewer_charge != null) {
        chat().myCharge = snap.viewer_charge;
        paintComposerIdentity();
      }
      renderSide('def', snap.owner, snap.owner_name, snap.owner_charge, snap.owner_pfp,
        'Defender — this planet\'s owner');
      var raiding = snap.raiding_fleet || state().raidingFleet;
      var br = document.getElementById('rv-hud-br');
      if (br) br.classList.toggle('hidden', !raiding);
      if (raiding) {
        renderSide('atk', snap.raider_id || raiding, snap.raider_name, snap.raider_charge,
          snap.raider_pfp, 'Raider — fleet ' + raiding);
      }
    }

    /** One HUD action bar: portrait, charge battery, and an identifying tooltip. */
    function renderSide(which, id, name, charge, pfp, label) {
      var portrait = document.getElementById('rv-' + which + '-portrait');
      if (portrait) {
        portrait.setAttribute('data-sui-tooltip',
          label + '\n' + whoLine(name, id)
          + (charge == null ? '' : '\nCharge ' + fmtNum(charge)));
      }
      paintPfp(document.getElementById('rv-' + which + '-pfp'), pfp);
      // Charge drives the 5-chunk battery by the game's OWN ladder, not a linear
      // scale: ChargeCalculator maps raw charge through the thresholds
      // [0,1,2,3,5,8] to a level 0-5. Copied rather than approximated so a
      // spectator reads the same "can this player act?" the owner does.
      paintBattery(document.getElementById('rv-' + which + '-battery'), charge);
    }

    // A portrait is STACKED IMAGE LAYERS, not one file: the chain stores part
    // indices in `pfpClientRenderAttributes` and the client composites them.
    // Same layer order as the game's PfpViewerComponent and the Team Ops roster,
    // so one player looks like the same person everywhere.
    /* The shared composer in pfp.js — the placeholder-on-nothing behaviour this
     * function documented is now its behaviour everywhere.
     *
     * This window is the reason validating matters: the portrait it draws
     * belongs to the player currently attacking you, from a string that player
     * wrote themselves, and this copy checked nothing before putting it in a
     * path.
     */
    function renderPfpInto(host, attrsJson) {
      window.StructsPfp.fillPortrait(host, attrsJson);
    }

    /* Repaint a portrait host, but only when the attributes actually changed.
     *
     * The guard is not an optimisation: `renderSide` runs on every snapshot,
     * several times a second during a raid, and a rebuild that swaps five <img>
     * elements each time makes the two HUD faces flicker.
     */
    function paintPfp(host, attrsJson) {
      if (!host || host.dataset.pfp === (attrsJson || '')) return;
      host.dataset.pfp = attrsJson || '';
      host.innerHTML = '';
      renderPfpInto(host, attrsJson);
    }

    /* Fill a 5-chunk battery from a raw charge, through the game's own ladder.
     *
     * `chargeLevel` is the port of ChargeCalculator's thresholds; this is the
     * paint. Both HUD action bars and the composer use it, because a player
     * comparing their own charge against the defender's must be reading the
     * same scale — that comparison is the whole reason the composer has one.
     */
    function paintBattery(battery, charge) {
      if (!battery) return;
      var level = chargeLevel(charge);
      var chunks = battery.children;
      for (var i = 0; i < chunks.length; i++) {
        chunks[i].classList.toggle('sui-mod-filled', i + 1 <= level);
      }
    }

    /* How this window names a player in a tooltip: "Marklifer (1-194)", falling
     * back to whichever half we have. Three portraits use it — defender, raider
     * and the composer — and they must read alike, because the whole point of
     * the third one is that it sits beside the other two.
     */
    function whoLine(name, id, unknown) {
      return name ? name + ' (' + (id || '?') + ')' : (id || unknown || 'unknown');
    }

    // Port of ChargeCalculator (util/ChargeCalculator.js): raw charge → level 0-5.
    var CHARGE_THRESHOLDS = [0, 1, 2, 3, 5, 8];
    function chargeLevel(charge) {
      if (charge == null) return 0;
      for (var i = 0; i < CHARGE_THRESHOLDS.length; i++) {
        if (charge <= CHARGE_THRESHOLDS[i]) return i;
      }
      return CHARGE_THRESHOLDS.length - 1;
    }

    /** Compact age: 45s / 12m / 3.2h. */
    function fmtAge(ms) {
      var s = Math.round(ms / 1000);
      if (s < 60) return s + 's ago';
      if (s < 3600) return Math.round(s / 60) + 'm ago';
      return (s / 3600).toFixed(1).replace(/\.0$/, '') + 'h ago';
    }

    /** `raid_status` / `shieldsVulnerable` → "raid status" / "shields vulnerable". */
    function humanStatus(s) {
      return String(s)
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .replace(/_/g, ' ')
        .toLowerCase();
    }
    /* The HUD shows shield and ore RAW, exactly as the game does — its
     * ShieldStatusComponent and StatusBarTopRightComponent both assign the
     * value straight to innerText with no formatter. (The design system's
     * "shorten over 999 as 1.11k" rule belongs to Result Rows and tables, a
     * different component; applying it here would make the spectator disagree
     * with the same planet's own HUD.) */
    function fmtNum(n) {
      return String(Math.round(Number(n) || 0));
    }
    function setText(id, text) {
      var e = document.getElementById(id);
      if (e) e.textContent = text;
    }

    return {
      renderHeader: renderHeader, renderSide: renderSide, paintPfp: paintPfp, paintBattery: paintBattery,
      whoLine: whoLine, chargeLevel: chargeLevel, CHARGE_THRESHOLDS: CHARGE_THRESHOLDS, fmtAge: fmtAge,
      humanStatus: humanStatus, fmtNum: fmtNum, setText: setText,
    };
  };
})();
