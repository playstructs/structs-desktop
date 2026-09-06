// Raid view — the cheatsheet: the Design System's component for "information
// about an ability or Struct", a POPOVER opened on a 500ms press-and-hold,
// appended to <body> so no ancestor's overflow can clip it, and positioned
// best-fit against the trigger. The content is ours (the game's builder
// reads a live GameState this window does not have); the MARKUP is the
// game's, so sui.css styles it.
//
// Extracted from raidview.js (2026-09-06). Collaborators arrive as a context
// so scripts/harness-tests/raidsheet.test.mjs can drive it with no window
// boot:
//
//   window.RaidSheet({ el, equipped, typeOf, state, icons })
//     → { initCheatsheets, placeCheatsheet, cheatsheetBody, structSheet, propertySheet,
//         sheetContent, batteryCost, fmtNumber, humanise, labelOr, ambitsOf, AMBIT_ORDER,
//         FIXED_SHEETS, STRUCT_DESCRIPTIONS }
(function () {
  'use strict';
  window.RaidSheet = function (ctx) {
    var el = ctx.el, equipped = ctx.equipped, typeOf = ctx.typeOf, state = ctx.state, icons = ctx.icons;

    /* ── Cheatsheet ──────────────────────────────────────────────────────────
       The Design System's component for "information about an ability or
       Struct", and a POPOVER rather than a panel body — `SUICheatsheet` opens it
       on a 500ms press-and-hold, appends it to <body> so no ancestor's overflow
       can clip it, and positions it best-fit against the trigger. Ported here so
       the detail a spectator wants (health, what this thing is, why it is
       inert) stays one press away from the icons that stand for it.

       The content is ours: the game's CheatsheetContentBuilder reads a live
       GameState this window deliberately does not have. The MARKUP is the
       game's, so sui.css styles it. */

    var CHEAT_DELAY = 500;

    function initCheatsheets() {
      var sheet = document.createElement('div');
      sheet.id = 'rv-cheatsheet';
      sheet.className = 'sui-cheatsheet';
      sheet.style.position = 'fixed';
      var timer = null;

      function hide() {
        clearTimeout(timer);
        if (sheet.parentElement) sheet.parentElement.removeChild(sheet);
      }

      document.addEventListener('mousedown', function (e) {
        var trig = e.target.closest ? e.target.closest('[data-sui-cheatsheet]') : null;
        hide();
        if (!trig) return;
        timer = setTimeout(function () {
          ['sui-theme-player', 'sui-theme-enemy', 'sui-theme-neutral']
            .forEach(function (c) { sheet.classList.remove(c); });
          sheet.classList.add('sui-theme-' + (trig.dataset.suiTheme || 'player'));
          sheet.innerHTML = '';
          sheet.appendChild(cheatsheetBody(trig));
          document.body.appendChild(sheet);
          placeCheatsheet(sheet, trig.getBoundingClientRect());
        }, CHEAT_DELAY);
      });
      document.addEventListener('mouseup', hide);
      document.addEventListener('mouseleave', hide);
      // A scroll under an open sheet would leave it pointing at nothing.
      var sc = document.getElementById('rv-scroll');
      if (sc) sc.addEventListener('scroll', hide);
    }

    /** Try above, then right, then below, then left — `SUIUtil.positionBestFit
     * Fixed`'s order — and clamp into the viewport. */
    function placeCheatsheet(sheet, r) {
      var w = sheet.offsetWidth, h = sheet.offsetHeight;
      var vw = window.innerWidth, vh = window.innerHeight, gap = 4;
      var top, left;
      if (r.top - h - gap >= 0)            { top = r.top - h - gap;  left = r.left + r.width / 2 - w / 2; }
      else if (r.right + w + gap <= vw)    { top = r.top + r.height / 2 - h / 2; left = r.right + gap; }
      else if (r.bottom + h + gap <= vh)   { top = r.bottom + gap;   left = r.left + r.width / 2 - w / 2; }
      else                                 { top = r.top + r.height / 2 - h / 2; left = r.left - w - gap; }
      sheet.style.top = Math.max(0, Math.min(top, vh - h)) + 'px';
      sheet.style.left = Math.max(0, Math.min(left, vw - w)) + 'px';
    }

    /* The content builder, ported from the game's `CheatsheetContentBuilder`.
     *
     * A Cheatsheet is KEYED by `data-sui-cheatsheet`, and the key selects one of
     * three shapes:
     *
     *   1. a FIXED key   (`icon-beacon`, `icon-blocked`, `icon-unpowered`, the
     *                     shield states, …) → a canned title + description;
     *   2. a STRUCT TYPE (key is the type's own name) with no
     *                     `data-selected-property` → the whole struct card:
     *                     "<model number> <class>", build costs, the type's
     *                     description, and one property row per equipped system;
     *   3. a STRUCT TYPE with `data-selected-property` → just that one ability:
     *                     its label, its battery cost, its description, and its
     *                     damage/range rows.
     *
     * Plus `data-action-button="defend"`, which the game special-cases.
     *
     * The labels and descriptions are HUMAN-WRITTEN COPY that exists only on the
     * Guild API's struct-type record (an authenticated endpoint), so they reach
     * this window through the snapshot rather than being invented here. Where a
     * label is missing — the game window has not synced yet — the enum name is
     * humanised as a fallback so a sheet is never empty or "undefined". */

    /** STRUCT_DESCRIPTIONS, verbatim. Keyed by the type's chain name. */
    var STRUCT_DESCRIPTIONS = {
      'Continental Power Plant': 'Consumes Alpha Matter to generate Energy.',
      'Field Generator': 'Consumes Alpha Matter to generate Energy.',
      'Jamming Satellite': 'Applies Signal Jamming to all enemy Smart Attacks.',
      'Orbital Shield Generator': 'Improves Planetary Defense.',
      'Ore Bunker': 'Massively improves Planetary Defense by storing Ore underground.',
      'Ore Extractor': 'Extracts Alpha Ore from the planet.',
      'Ore Refinery': 'Refines Ore into usable Alpha Matter.',
      'Planetary Defense Cannon': 'Launches Counter-Attacks against attacking Structs.',
      'World Engine': 'Consumes Alpha Matter to generate Energy.'
    };

    /** STRUCT_WEAPON_CONTROL_LABELS. */
    var WEAPON_CONTROL_LABEL = { guided: 'Smart Weapon', unguided: 'Ballistic Weapon' };

    /** The fixed-key sheets, exactly as `build()`'s switch spells them. */
    var FIXED_SHEETS = {
      'icon-beacon': ['Planetary Beacon', 'Planetary Structs can be deployed to this location.'],
      'icon-blocked': ['Blocked', 'Structs cannot be deployed to this location.'],
      'icon-cmd-post': ['Command Post', 'Only the Command Ship can be deployed to this location.'],
      'icon-enemy-tile': ['Enemy Territory', 'Structs cannot be deployed in Enemy Territory.'],
      'icon-fleet-tile': ['Fleet Territory', 'Fleet Structs can be deployed to this location.'],
      'icon-unknown-territory': ['Unknown Territory', 'There is nothing of interest here yet.'],
      'enemy-struct-deploying': ['Enemy Struct Deploying', 'A new enemy struct is being deployed.'],
      'icon-unpowered': ['Unpowered', "This Struct is not receiving power. It's abilities are not active."],
      'icon-attention': ['No Alpha Infused', 'Consume Alpha Matter to generate Energy.'],
      'icon-wreckage': ['Wreckage', 'This Struct has been destroyed.']
    };

    /** AMBIT_ORDER, and the chain's ambit bitmask (Water=2, Land=4, Air=8,
     * Space=16). The webapp gets ready-made arrays from the Guild API; from a
     * mask we expand them ourselves, in the same order the icons are shown. */
    var AMBIT_ORDER = ['space', 'air', 'land', 'water'];
    var AMBIT_BIT = { water: 2, land: 4, air: 8, space: 16 };

    function ambitsOf(mask) {
      return AMBIT_ORDER.filter(function (a) { return (mask & AMBIT_BIT[a]) !== 0; });
    }

    /** `NumberFormatter.format` — 1-3 leading digits plus a scale letter, and it
     * TRUNCATES (5,590,000 → "5M"). Ported so costs read as the game shows them,
     * including the lowercase kilo the game's own scale map uses ('1': 'k'). */
    var NUM_SCALE = ['', 'k', 'M', 'G', 'T', 'P', 'E', 'Z', 'Y', 'R', 'Q'];
    function fmtNumber(n) {
      var str = String(parseInt(n, 10) || 0);
      if (str.length <= 3) return str;
      var rem = str.length % 3 || 3;
      return str.substring(0, rem) + (NUM_SCALE[(str.length - rem) / 3] || '');
    }

    /** Turn `noOreReserveDefenses` / `signalJamming` into "Signal Jamming" —
     * only used when the Guild API copy has not reached us. */
    function humanise(enumName) {
      if (!enumName) return '';
      return enumName
        .replace(/([A-Z])/g, ' $1')
        .replace(/^./, function (c) { return c.toUpperCase(); })
        .trim();
    }

    function labelOr(label, enumName) { return label || humanise(enumName); }

    /* ── Sheet primitives, mirroring SUICheatsheetRenderer ─────────────────── */

    function ambitIcons(list) {
      var wrap = document.createDocumentFragment();
      list.forEach(function (a) { wrap.appendChild(el('i', 'sui-icon sui-icon-' + a)); });
      return wrap;
    }

    /** One property row: an icon, then one or two lines of info. `lines` entries
     * may be strings or nodes. */
    function sheetRow(iconClass, lines) {
      var row = el('div', 'sui-cheatsheet-property');
      var ico = el('div', 'sui-cheatsheet-property-icon');
      ico.appendChild(el('i', 'sui-icon sui-icon-md ' + iconClass));
      row.appendChild(ico);
      var info = el('div', 'sui-cheatsheet-property-info');
      lines.forEach(function (line) {
        if (line == null) return;
        var d = el('div');
        if (typeof line === 'string') d.textContent = line;
        else d.appendChild(line);
        info.appendChild(d);
      });
      row.appendChild(info);
      return row;
    }

    /** A line of text followed by ambit icons — the "N DMG <icons>" shape. */
    function textThenAmbits(text, ambits) {
      var f = document.createDocumentFragment();
      f.appendChild(document.createTextNode(text + ' '));
      f.appendChild(ambitIcons(ambits));
      return f;
    }

    /** `renderBatteryCostHTML` — the charge ladder rendered as battery chunks.
     * Same thresholds as ChargeCalculator, and the same "one chunk per threshold
     * above the first" loop. */
    var CHARGE_THRESHOLDS = [0, 1, 2, 3, 5, 8];
    function batteryCost(charge) {
      var level = 0;
      for (var i = 0; i < CHARGE_THRESHOLDS.length; i++) {
        if (charge >= CHARGE_THRESHOLDS[i]) level = i;
      }
      var bat = el('div', 'sui-battery');
      for (var j = 1; j < CHARGE_THRESHOLDS.length; j++) {
        bat.appendChild(el('div', 'sui-battery-chunk' + (j <= level ? ' sui-mod-filled' : '')));
      }
      return bat;
    }

    /** `renderContentHTML`: top frame, title (with costs), then content of
     * description / property section / contextual message — in that order. */
    function sheetContent(titleText, charge, energy, description, contextualMessage, rows) {
      var frag = document.createDocumentFragment();
      frag.appendChild(el('div', 'sui-cheatsheet-top-frame'));

      var title = el('div', 'sui-cheatsheet-title');
      title.appendChild(el('div', 'sui-cheatsheet-title-text', String(titleText || '').toUpperCase()));
      var costs = el('div', 'sui-cheatsheet-costs');
      if (charge != null) costs.appendChild(batteryCost(charge));
      if (energy != null) {
        var c = el('div', 'sui-cheatsheet-cost', fmtNumber(energy) + ' ');
        c.appendChild(el('i', 'sui-icon sui-icon-energy'));
        costs.appendChild(c);
      }
      title.appendChild(costs);
      frag.appendChild(title);

      var content = el('div', 'sui-cheatsheet-content');
      if (description) content.appendChild(el('div', 'sui-cheatsheet-description', description));
      if (rows && rows.length) {
        var sec = el('div', 'sui-cheatsheet-property-section');
        rows.forEach(function (r) { sec.appendChild(r); });
        content.appendChild(sec);
      }
      if (contextualMessage) {
        content.appendChild(el('div', 'sui-cheatsheet-contextual-message', contextualMessage));
      }
      frag.appendChild(content);
      return frag;
    }

    /* ── The struct card (no selected property) ────────────────────────────── */

    /** `renderWeaponProperty`: label, then "N DMG (+ARMOUR PIERCING) <ambits>". */
    function weaponRow(weaponType, label, damage, ambits, armourPiercing) {
      if (!equipped(weaponType)) return null;
      var icon = icons()[weaponType];
      if (!icon) return null;
      return sheetRow(icon, [
        label,
        textThenAmbits(damage + ' DMG' + (armourPiercing ? ' (+ARMOUR PIERCING)' : ''), ambits)
      ]);
    }

    /** `renderPassiveWeaponProperty`. Counter-attacks in the struct's OWN ambit
     * can hit harder; when they do, the game splits the row into two damage
     * figures rather than showing one misleading number. */
    function passiveRow(st) {
      if (!equipped(st.passive_weaponry)) return null;
      var icon = icons()[st.passive_weaponry];
      if (!icon) return null;
      var reach = ambitsOf(st.primary_weapon_ambits | st.secondary_weapon_ambits);
      var own = ambitsOf(st.possible_ambit);
      var line;
      if (st.counter_attack_same_ambit > st.counter_attack) {
        var regular = reach.filter(function (a) { return own.indexOf(a) < 0; });
        var same = reach.filter(function (a) { return own.indexOf(a) >= 0; });
        line = document.createDocumentFragment();
        if (regular.length) {
          line.appendChild(document.createTextNode(st.counter_attack + ' DMG '));
          line.appendChild(ambitIcons(regular));
          line.appendChild(document.createTextNode(' '));
        }
        if (same.length) {
          line.appendChild(document.createTextNode(st.counter_attack_same_ambit + ' DMG '));
          line.appendChild(ambitIcons(same));
        }
      } else {
        line = textThenAmbits(st.counter_attack + ' DMG', reach);
      }
      return sheetRow(icon, [labelOr(st.passive_weaponry_label, st.passive_weaponry), line]);
    }

    /** The whole-struct card: `buildStructCheatsheet`. */
    function structSheet(st, contextualMessage) {
      var rows = [];
      rows.push(weaponRow(
        st.primary_weapon,
        labelOr(st.primary_weapon_label, st.primary_weapon),
        st.primary_weapon_damage,
        ambitsOf(st.primary_weapon_ambits),
        st.primary_weapon_armour_piercing));
      rows.push(weaponRow(
        st.secondary_weapon,
        labelOr(st.secondary_weapon_label, st.secondary_weapon),
        st.secondary_weapon_damage,
        ambitsOf(st.secondary_weapon_ambits),
        st.secondary_weapon_armour_piercing));
      rows.push(passiveRow(st));

      if (equipped(st.unit_defenses) && icons()[st.unit_defenses]) {
        rows.push(sheetRow(icons()[st.unit_defenses],
          [labelOr(st.unit_defenses_label, st.unit_defenses)]));
      }
      // The defensive cannon is a weapon in all but name: the game renders it
      // through renderWeaponProperty at 1 DMG across every ambit.
      if (st.planetary_defenses === 'defensiveCannon') {
        rows.push(weaponRow('defensiveCannon',
          labelOr(st.planetary_defenses_label, st.planetary_defenses),
          1, AMBIT_ORDER.slice(), false));
      } else if (equipped(st.planetary_defenses) && icons()[st.planetary_defenses]) {
        rows.push(sheetRow(icons()[st.planetary_defenses],
          [labelOr(st.planetary_defenses_label, st.planetary_defenses)]));
      }
      if (equipped(st.ore_reserve_defenses) && icons()[st.ore_reserve_defenses]) {
        rows.push(sheetRow(icons()[st.ore_reserve_defenses], [
          labelOr(st.ore_reserve_defenses_label, st.ore_reserve_defenses),
          '+' + fmtNumber(st.planetary_shield_contribution) + ' Planetary Defense'
        ]));
      }
      if (equipped(st.power_generation)) {
        rows.push(sheetRow('icon-send-alpha', ['Consume Alpha']));
        rows.push(sheetRow(icons()[st.power_generation] || 'icon-refine',
          ['+' + st.generating_rate + ' KW Per Alpha']));
      }

      var title = (st.default_cosmetic_model_number
        ? st.default_cosmetic_model_number + ' ' : '') + (st.class_name || st.class_abbreviation);

      return sheetContent(
        title,
        st.build_charge || null,
        st.build_draw || null,
        STRUCT_DESCRIPTIONS[st.class_name] || '',
        contextualMessage,
        rows.filter(Boolean));
    }

    /* ── The single-ability card (selected property) ───────────────────────── */

    /** `renderPropertiesForWeapon`: control label, damage (a range when the
     * weapon fires more than once), reach, and armour piercing. */
    function weaponPropertyRows(weaponType, control, damage, shots, ambits, armourPiercing) {
      var rows = [];
      var icon = icons()[weaponType];
      if (icon) rows.push(sheetRow(icon, [WEAPON_CONTROL_LABEL[control] || humanise(control)]));
      rows.push(sheetRow('icon-dmg',
        [shots > 1 ? (damage + '-' + (damage * shots) + ' DMG') : (damage + ' DMG')]));
      rows.push(sheetRow('icon-range', [ambitIcons(ambits)]));
      if (armourPiercing) rows.push(sheetRow('icon-mine', ['Armour Piercing']));
      return rows;
    }

    /** `buildStructPropertyCheatsheet`. */
    function propertySheet(st, property) {
      switch (property) {
        case 'primary_weapon':
          return sheetContent(
            labelOr(st.primary_weapon_label, st.primary_weapon),
            st.primary_weapon_charge, null, st.primary_weapon_description, null,
            weaponPropertyRows(st.primary_weapon, st.primary_weapon_control,
              st.primary_weapon_damage, st.primary_weapon_shots,
              ambitsOf(st.primary_weapon_ambits), st.primary_weapon_armour_piercing));
        case 'secondary_weapon':
          return sheetContent(
            labelOr(st.secondary_weapon_label, st.secondary_weapon),
            st.secondary_weapon_charge, null, st.secondary_weapon_description, null,
            weaponPropertyRows(st.secondary_weapon, st.secondary_weapon_control,
              st.secondary_weapon_damage, st.secondary_weapon_shots,
              ambitsOf(st.secondary_weapon_ambits), st.secondary_weapon_armour_piercing));
        case 'movable':
          return sheetContent(labelOr(st.drive_label, 'drive'),
            st.move_charge, null, st.drive_description, null, []);
        case 'passive_weaponry': {
          var reach = ambitsOf(st.primary_weapon_ambits | st.secondary_weapon_ambits);
          var dmg = st.counter_attack_same_ambit > st.counter_attack
            ? (st.counter_attack + '-' + st.counter_attack_same_ambit + ' DMG')
            : (st.counter_attack + ' DMG');
          return sheetContent(
            labelOr(st.passive_weaponry_label, st.passive_weaponry),
            null, null, st.passive_weaponry_description, null,
            [sheetRow('icon-dmg', [dmg]), sheetRow('icon-range', [ambitIcons(reach)])]);
        }
        case 'unit_defenses':
          return sheetContent(labelOr(st.unit_defenses_label, st.unit_defenses),
            null, null, st.unit_defenses_description, null, []);
        case 'ore_reserve_defenses':
          return sheetContent(
            labelOr(st.ore_reserve_defenses_label, st.ore_reserve_defenses),
            null, null, st.ore_reserve_defenses_description, null,
            icons()[st.ore_reserve_defenses] ? [sheetRow(icons()[st.ore_reserve_defenses], [
              labelOr(st.ore_reserve_defenses_label, st.ore_reserve_defenses),
              '+' + fmtNumber(st.planetary_shield_contribution) + ' Planetary Defense'
            ])] : []);
        case 'planetary_defenses':
          return sheetContent(
            labelOr(st.planetary_defenses_label, st.planetary_defenses),
            null, null, st.planetary_defenses_description, null,
            st.planetary_defenses === 'defensiveCannon'
              ? [sheetRow('icon-dmg', ['1 DMG']),
                 sheetRow('icon-range', [ambitIcons(AMBIT_ORDER.slice())])]
              : []);
        case 'stealth_systems':
          // The game reaches stealth through unit_defenses; the button carries
          // its own charge, which is the one fact that row adds.
          return sheetContent(labelOr(st.unit_defenses_label, 'stealthMode'),
            st.stealth_activate_charge, null, st.unit_defenses_description, null, []);
        case 'power_generation':
          // The game's own switch has no `power_generation` case, so its Consume
          // Alpha button opens an empty sheet. Filled in here from the type's
          // generating rate rather than reproducing that gap.
          return sheetContent('Consume Alpha', null, null,
            'Consumes Alpha Matter to generate Energy.', null,
            [sheetRow(icons()[st.power_generation] || 'icon-refine',
              ['+' + st.generating_rate + ' KW Per Alpha'])]);
        default:
          return null;
      }
    }

    /** Cheatsheet content for a trigger — the `build(dataset)` dispatch. */
    function cheatsheetBody(trig) {
      var key = trig.dataset.suiCheatsheet || '';
      var s = state().structsById[trig.dataset.struct || ''] || null;
      var st = s ? typeOf(s) : null;

      var fixed = FIXED_SHEETS[key];
      if (fixed) return sheetContent(fixed[0], null, null, fixed[1], null, []);

      // Economy icons whose value the SPECTATOR does not have. The game shows a
      // count here read from the owner's own inventory; saying "N Ore" with a
      // number we cannot see would be a lie, so the sheet states the capability.
      if (key === 'icon-mine') {
        return sheetContent('Ore Extraction', null, null,
          'This Struct extracts Alpha Ore from the planet.', null, []);
      }
      if (key === 'icon-ore-ready') {
        return sheetContent('Ore Refining', null, null,
          'This Struct refines Ore into usable Alpha Matter.', null, []);
      }
      if (key === 'icon-refine' && !st) {
        return sheetContent('Power Generation', null, null,
          'Consumes Alpha Matter to generate Energy.', null, []);
      }

      if (!st) {
        // A type we could not resolve — name it rather than showing a blank box.
        return sheetContent(s ? (s.type_name || s.type_slug) : humanise(key.replace(/^icon-/, '')),
          null, null, '', null, []);
      }

      if (trig.dataset.actionButton === 'defend') {
        return sheetContent('Defend', st.defend_change_charge, null,
          'Blocks incoming damage and counter-attacks on behalf of another Struct.',
          null, []);
      }

      if (trig.dataset.selectedProperty) {
        var sheet = propertySheet(st, trig.dataset.selectedProperty);
        if (sheet) return sheet;
      }

      // The whole-struct card. The contextual message is the spectator's one
      // addition: WHY this Struct is currently inert.
      var msg = s && s.destroyed ? 'Destroyed.'
        : (s && !s.built ? 'Under construction.'
        : (s && s.online === false ? 'Unpowered — abilities inactive.'
        : (s && s.hidden ? 'In stealth.' : null)));
      return structSheet(st, msg);
    }

    return {
      initCheatsheets: initCheatsheets, placeCheatsheet: placeCheatsheet, cheatsheetBody: cheatsheetBody,
      structSheet: structSheet, propertySheet: propertySheet, sheetContent: sheetContent, batteryCost: batteryCost,
      fmtNumber: fmtNumber, humanise: humanise, labelOr: labelOr, ambitsOf: ambitsOf, AMBIT_ORDER: AMBIT_ORDER,
      FIXED_SHEETS: FIXED_SHEETS, STRUCT_DESCRIPTIONS: STRUCT_DESCRIPTIONS,
    };
  };
})();
