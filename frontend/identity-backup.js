/* ── [structs-universe] account key: skip the recovery-key screens ──
 *
 * The webapp's signup runs SetUsername → Recovery Key intro → Create (show the
 * 12 words) → Confirm (type them back) → Success → loggingIn. The desktop app
 * replaces the middle four with a file: when the flow reaches the intro, this
 * shows the webapp's own "Connecting…" page, writes the mnemonic to
 * `<data_dir>/structs-app/identities/` (identity_backup.rs), and only then
 * creates the account — what the Confirm screen's submit did.
 *
 * The file is written FIRST so an account never exists whose key was saved
 * nowhere but localStorage. If the write or the signup fails, the webapp's own
 * screens run instead: the player then sees their words, which beats an
 * account nobody can recover.
 *
 * The webapp is untouched; this wraps `menuPage.router.goto` the same way the
 * sound hooks in structs-config.js do, and reaches `authManager` /
 * `walletManager` through the Auth controller that holds them.
 */
(function setupIdentityBackup() {
  'use strict';

  // Every page of the recovery-key stretch. The later ones are listed too so a
  // player restored onto one of them (an upgrade mid-signup) is caught as well.
  var SKIPPED = {
    signupRecoveryKeyIntro: true,
    signupRecoveryKeyCreation: true,
    signupRecoveryKeyConfirmation: true,
    signupRecoveryKeyConfirmFail: true,
    signupRecoveryKeyFaq: true,
    signupSuccess: true,
  };

  var fallback = false; // a save or signup failed: the webapp's screens run
  var running = false;

  function invoke(cmd, args) {
    var t = window.__TAURI__;
    if (!t || !t.core) return Promise.reject(new Error('not running in the desktop app'));
    return t.core.invoke(cmd, args);
  }

  function isPreview(router) {
    return !!router.mode && String(router.mode).toUpperCase() === 'PREVIEW';
  }

  function complete(router, orig) {
    var gs = window.gameState;
    var auth = router.controllers && router.controllers.get && router.controllers.get('Auth');
    if (!gs || !auth || !auth.authManager || !auth.walletManager) {
      return giveUp(router, orig, 'webapp internals not found');
    }
    running = true;
    orig.call(router, 'Auth', 'loggingIn', {});

    if (!gs.mnemonic) gs.mnemonic = auth.walletManager.createMnemonic();
    var req = gs.signupRequest || {};

    invoke('save_identity_backup', {
      mnemonic: gs.mnemonic,
      dest: 'backup',
      username: req.username || null,
      guildId: (gs.thisGuild && gs.thisGuild.id) || null,
      playerId: null,
    }).then(function () {
      return auth.authManager.signup(gs.mnemonic);
    }).then(function (ok) {
      if (!ok) throw new Error('signup was refused');
      gs.save();
      running = false;
      // Already on loggingIn; the new-planet listener takes it from here.
    }).catch(function (e) {
      running = false;
      giveUp(router, orig, e && e.message ? e.message : String(e));
    });
  }

  function giveUp(router, orig, why) {
    console.warn('[Identity] showing the recovery-key screens instead: ' + why);
    fallback = true;
    orig.call(router, 'Auth', 'signupRecoveryKeyIntro', {});
  }

  function install(router) {
    if (typeof router.goto !== 'function' || router.goto.__structsIdentity) return;
    var orig = router.goto;
    var w = function (controller, page, options) {
      if (controller === 'Auth' && SKIPPED[page] && !fallback && !isPreview(router)) {
        if (!running) complete(router, orig);
        return;
      }
      return orig.apply(this, arguments);
    };
    w.__structsIdentity = true;
    router.goto = w;
  }

  // The bundle loads after this file; menuPage appears when it evaluates,
  // long before any player can reach the username screen.
  var tries = 0;
  (function poll() {
    var r = window.menuPage && window.menuPage.router;
    if (r) return install(r);
    if (++tries < 1200) setTimeout(poll, 50);
  })();
})();
