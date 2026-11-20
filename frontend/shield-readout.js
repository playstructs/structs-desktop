// The planetary shield readout, exactly as the game draws it — one copy for
// every surface that shows it (the Raid View HUD, the Terminal's Raid card).
//
// Ported verbatim from structs-webapp so a spectator reads the same figure as
// the planet's own HUD: ShieldStatusComponent.getShieldReadout,
// KeyPlayer.setPlanetShieldHealth / getProjectedShieldBreachTime,
// PlanetRaid.isRaidActive, DifficultyEstimator and DateFormatter.formatDuration
// (TASK: 6000 ms blocks, 30,000-block cap). Parity over taste: the estimator
// multiplies by the block time in ms where its comment says seconds, and that
// is kept. scripts/harness-tests/raidhud.test.mjs runs the webapp's own source
// against this file.
//
// The STATE is the game's KeyPlayer.arePlanetaryDefenses{Secure,Breached}():
// secure while the defender's Command Ship is on station, breached when it is
// not AND a raid is running, vulnerable otherwise. It is never read off
// `planetaryShield` — that is the raid proof's decay range and practically
// never reaches 0.
//
//   window.ShieldReadout.readout(secure, raidStatus, shield, blockStartRaid, height)
//     → { state: 'secure'|'vulnerable'|'breached'|null, text, warning }
(function () {
  'use strict';
  var ESTIMATED_BLOCK_TIME = 6000, MAX_BLOCKS_WHEN_ESTIMATING = 30000;
  var RAID_ACTIVE = { initiated: 1, ongoing: 1, shieldsVulnerable: 1 };

  function calculatedDifficulty(age, range) {
    if (age <= 1) return 64;
    return Math.max(1, 64 - Math.floor(Math.log10(age) / Math.log10(range) * 63));
  }

  // Pure in the shield value and up to 30,000 iterations, and the Raid View
  // header re-renders every block — so remember the answer per shield.
  var memo = {};
  function totalBlocksNeeded(difficultyTarget) {
    var range = Math.max(Number(difficultyTarget) || 0, 1);
    if (memo[range] != null) return memo[range];
    var expected = 0, ahead = 0;
    while (expected < 1 && ahead < MAX_BLOCKS_WHEN_ESTIMATING) {
      expected += ESTIMATED_BLOCK_TIME / Math.pow(16, calculatedDifficulty(ahead, range));
      ahead++;
    }
    return (memo[range] = Math.min(ahead, MAX_BLOCKS_WHEN_ESTIMATING));
  }

  function timeRemaining(difficultyTarget, blockStartRaid, currentBlock) {
    var age = Math.max(currentBlock - blockStartRaid, 0);
    return Math.max(totalBlocksNeeded(difficultyTarget) - age, 0) * ESTIMATED_BLOCK_TIME;
  }

  function formatDuration(ms) {
    var seconds = Math.floor(ms / 1000), minutes = Math.floor(seconds / 60), hours = Math.floor(minutes / 60);
    if (hours > 0) return hours + 'h';
    if (minutes > 0) return minutes + 'm';
    return seconds + 's';
  }

  /**
   * @param {boolean|null|undefined} secure  the snapshot's owner_defenses_secure
   * @return {{state: string|null, text: string, warning: boolean}}
   *   state null = could not tell; a caller keeps whatever it last showed.
   */
  function readout(secure, raidStatus, shield, blockStartRaid, height) {
    if (secure == null) return { state: null, text: '—', warning: false };
    if (secure) return { state: 'secure', text: 'Secure', warning: false };
    var breached = !!RAID_ACTIVE[raidStatus];
    // The countdown only once breached, and only with a raid start and a head
    // to measure from; otherwise the projected time from scratch.
    if (breached && Number(height) && Number(blockStartRaid)) {
      return { state: 'breached', text: formatDuration(timeRemaining(shield, Number(blockStartRaid), Number(height))), warning: true };
    }
    return { state: breached ? 'breached' : 'vulnerable', text: formatDuration(timeRemaining(shield, 1, 1)), warning: true };
  }

  window.ShieldReadout = {
    readout: readout, formatDuration: formatDuration, totalBlocksNeeded: totalBlocksNeeded, timeRemaining: timeRemaining,
  };
})();
