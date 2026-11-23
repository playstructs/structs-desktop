/* ── [structs-universe] never offer New Player over a saved account ──
 *
 * The webapp opens `Auth.index` (New Player / Returning Player) whenever its
 * boot sign-in is refused, whatever the reason: the wrong guild's server, an
 * outage it cannot retry, a revoked device key. The account key is still in
 * localStorage at that point, and New Player would sign a second account up
 * over it. A saved account therefore gets a sign-in page instead: it keeps
 * trying, and offers Try Again, Returning Player and Log Out. Log Out writes
 * the account key file first, so nothing is lost by it.
 *
 * Once the player IS signed in, the same pages are never reopened: the router
 * restores whatever page it last showed, so one refused sign-in used to leave
 * `Auth.index` behind the closed menu on every launch after it.
 *
 * The webapp is untouched. The wrap goes on the instant the bundle publishes
 * `window.menuPage` (an accessor, not a poll): nothing can navigate first.
 */
(function setupSavedAccount() {
  'use strict';

  // Every way in to making a new account. The rest of signup is reachable only
  // through these.
  var ENTRY = { index: true, introduction: true, signupConnectingToCorporate1: true };

  var RETRY_KEY = 'structsSignInRetries';
  var RETRY_MS = [15000, 30000, 60000, 120000, 300000];
  // A wrong-guild launch corrects itself in about a second (the app switches
  // servers and reloads), so the choices wait until it plainly has not.
  var CHOICES_MS = 4000;

  var timers = [];

  function clearTimers() {
    timers.forEach(clearTimeout);
    timers = [];
  }

  function me(gs) {
    return (gs && gs.keyPlayers && gs.keyPlayers.player) || {};
  }

  /** The saved account's player id, or null when there is no account to protect. */
  function savedPlayerId() {
    var gs = window.gameState;
    // Logging out, Combat Training, spectating: not this player's own session.
    if (!gs || gs.persistenceEnabled === false) return null;
    if (gs.mnemonic && me(gs).id) return me(gs).id;
    // The boot can fail before the saved state reached gameState.
    try {
      var saved = JSON.parse(window.localStorage.getItem('gameState') || 'null');
      if (saved && saved.mnemonic && saved.thisPlayerId) return saved.thisPlayerId;
    } catch (e) { /* unreadable is not an account */ }
    return null;
  }

  function retries() {
    try { return parseInt(sessionStorage.getItem(RETRY_KEY) || '0', 10) || 0; } catch (e) { return 0; }
  }

  function setRetries(n) {
    try { sessionStorage.setItem(RETRY_KEY, String(n)); } catch (e) { /* per-session only */ }
  }

  function reload() { window.location.reload(); }

  function retry() {
    setRetries(retries() + 1);
    reload();
  }

  function screen(menu, nav, body) {
    menu.setNavItems([{ id: 'nav-item-text-only', label: nav, actionHandler: function () {} }]);
    menu.disableCloseBtn();
    menu.showNav();
    menu.useOpaqueBackground();
    menu.hideAndClearDialoguePanel();
    menu.setBodyContent(body);
  }

  function onClick(id, handler) {
    document.getElementById(id).addEventListener('click', handler);
  }

  function showSignIn(menu) {
    var router = menu.router;
    clearTimers();

    // A navigation like any other: page work in flight stops, and no page is
    // left current for a background refresh to draw over this one.
    router.navigationController.abort();
    router.navigationController = new AbortController();
    router.navigationId++;
    router.currentController = null;
    router.currentPage = null;
    router.currentOptions = {};

    screen(menu, 'Signing In', ''
      + '<div class="sui-page-body-screen-content sui-screen-body justified-centered">'
      + '<img class="glitch-logo" src="/img/sui/logo/logo-structs.gif" alt="Structs">'
      + '<img class="loading-3-dots" src="/img/loading-3-dots.gif" alt="Signing in">'
      + '<div id="saved-account-choices" class="device-activation-btn-container hidden">'
      + '<div class="sui-text-warning">Sign-in failed. Retrying.</div>'
      + '<a id="saved-account-retry" href="javascript: void(0)" class="sui-screen-btn fixed-256 sui-mod-primary">Try Again</a>'
      + '<a id="saved-account-returning" href="javascript: void(0)" class="sui-screen-btn fixed-256 sui-mod-secondary">Returning Player</a>'
      + '<a id="saved-account-logout" href="javascript: void(0)" class="sui-screen-btn fixed-256 sui-mod-secondary">Log Out</a>'
      + '</div>'
      + '</div>');

    onClick('saved-account-retry', retry);
    onClick('saved-account-returning', function () { router.goto('Auth', 'loginActivateDevice'); });
    onClick('saved-account-logout', function () { showLogout(menu); });

    timers.push(setTimeout(function () {
      var el = document.getElementById('saved-account-choices');
      if (el) el.classList.remove('hidden');
    }, CHOICES_MS));
    timers.push(setTimeout(retry, RETRY_MS[Math.min(retries(), RETRY_MS.length - 1)]));
  }

  function showLogout(menu) {
    clearTimers(); // no reload under a question
    screen(menu, 'Log Out', ''
      + '<div class="sui-page-body-screen-content sui-screen-body justified-centered">'
      + '<div class="device-activation-cancelled-text-container">'
      + '<div class="sui-text-destructive"><i class="sui-icon sui-icon-md icon-alert"></i> '
      + '<span id="saved-account-logout-title"></span></div>'
      + '<div id="saved-account-logout-error" class="sui-text-warning"></div>'
      + '</div>'
      + '<div class="device-activation-btn-container">'
      + '<a id="saved-account-cancel" href="javascript: void(0)" class="sui-screen-btn fixed-256 sui-mod-primary">Cancel</a>'
      + '<a id="saved-account-confirm" href="javascript: void(0)" class="sui-screen-btn fixed-256 sui-mod-destructive">Log Out</a>'
      + '</div>'
      + '</div>');
    document.getElementById('saved-account-logout-title').textContent = 'Log out of player ' + savedPlayerId() + '?';
    onClick('saved-account-cancel', function () { showSignIn(menu); });

    var running = false;
    onClick('saved-account-confirm', function () {
      if (running) return;
      running = true;
      document.getElementById('saved-account-logout-error').textContent = '';
      backupThenLogout(menu.router).catch(function (e) {
        running = false;
        console.warn('[SavedAccount] log out stopped:', e);
        var el = document.getElementById('saved-account-logout-error');
        if (el) el.textContent = 'The account key could not be saved, so you are still logged in.';
      });
    });
  }

  /** The key file first; only then may the webapp erase its copy. */
  function backupThenLogout(router) {
    return Promise.resolve().then(function () {
      var gs = window.gameState || {};
      var t = window.__TAURI__;
      var auth = router.controllers.get('Auth');
      if (!gs.mnemonic || !t || !t.core || !auth || !auth.authManager) throw new Error('not ready');
      return t.core.invoke('save_identity_backup', {
        mnemonic: gs.mnemonic,
        dest: 'backup',
        username: null,
        guildId: (gs.thisGuild && gs.thisGuild.id) || null,
        playerId: me(gs).id || null,
      }).then(function () { return auth.authManager.logout(); });
    });
  }

  function install(menu) {
    var router = menu && menu.router;
    if (!router || typeof router.goto !== 'function' || router.goto.__structsSavedAccount) return;

    var navigate = router.goto;
    var w = function (controller, page) {
      if (controller === 'Auth' && ENTRY[page] && savedPlayerId()) {
        if (me(window.gameState).player) return router.goto('Fleet', 'index');
        return showSignIn(menu);
      }
      clearTimers();
      return navigate.apply(this, arguments);
    };
    w.__structsSavedAccount = true;
    router.goto = w;

    var restore = router.restore;
    if (typeof restore !== 'function') return;
    router.restore = function (controller, page, options) {
      setRetries(0); // only reached once signed in
      var saved = null;
      try { saved = JSON.parse(window.localStorage.getItem('currentMenuPage') || 'null'); } catch (e) { /* ignored */ }
      if (saved && saved.controller === 'Auth') return router.goto(controller, page, options);
      return restore.apply(this, arguments);
    };
  }

  var current = window.menuPage;
  if (current) install(current);
  Object.defineProperty(window, 'menuPage', {
    configurable: true,
    enumerable: true,
    get: function () { return current; },
    set: function (v) { current = v; install(v); },
  });
})();
