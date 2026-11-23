// frontend/saved-account.js against the webapp's real MenuPageRouter: a saved
// account is never shown New Player, a player with none always is, and nothing
// on the way out (Log Out) can erase a key that was not written to disk first.
import { readFileSync } from 'fs';
import { JSDOM } from 'jsdom';

let failures = 0;
const check = (name, ok, detail) => {
  console.log((ok ? '  ok ' : 'FAIL ') + name + (ok || detail == null ? '' : ' — ' + detail));
  if (!ok) failures++;
};
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const root = process.cwd().replace(/\/scripts\/harness-tests$/, '');
const src = readFileSync(root + '/frontend/saved-account.js', 'utf8');
const routerSrc = readFileSync(root + '/structs-webapp/src/js/framework/MenuPageRouter.js', 'utf8')
  .replace(/^import .*$/m, "const MENU_PAGE_ROUTER_MODES = { DEFAULT: 'DEFAULT', PREVIEW: 'PREVIEW' };")
  .replace('export class', 'window.MenuPageRouter = class');
const WORDS = 'apple mask lens scout acid exclude evolve double build theme tone enlist';

function game({ account = true, inMemory = account, signedIn = false, persistence = true, page = null, backupFails = false, inject = src } = {}) {
  const dom = new JSDOM('<!doctype html><body><div id="body"></div></body>', { url: 'http://localhost/', runScripts: 'outside-only' });
  const w = dom.window;
  const log = [];
  const rendered = [];
  const timers = [];
  w.setTimeout = (f, ms) => { timers.push({ f, ms, live: true }); return timers.length; };
  w.clearTimeout = (id) => { if (timers[id - 1]) timers[id - 1].live = false; };
  w.console.warn = () => {};
  // location.reload is unforgeable in jsdom; the one call site is swapped out.
  w.__reload = () => log.push('reload');
  inject = inject.replace('window.location.reload();', 'window.__reload();');

  if (account) w.localStorage.setItem('gameState', JSON.stringify({ mnemonic: WORDS, thisPlayerId: '1-194' }));
  if (page) {
    w.localStorage.setItem('currentMenuPage', JSON.stringify(page));
    w.localStorage.setItem('lastMenuPage', JSON.stringify({ controller: null, page: null, options: {} }));
  }
  w.gameState = {
    persistenceEnabled: persistence,
    mnemonic: inMemory ? WORDS : null,
    keyPlayers: { player: { id: inMemory ? '1-194' : undefined, player: signedIn ? { id: '1-194' } : null } },
    thisGuild: { id: '0-1' },
  };
  w.__TAURI__ = { core: { invoke: async (cmd, args) => {
    log.push(cmd + ':' + args.dest + ':' + args.playerId);
    if (backupFails) throw new Error('disk full');
    return {};
  } } };

  w.eval(routerSrc);
  const router = new w.MenuPageRouter();
  const pages = (name) => new Proxy({ name }, { get: (t, p) => p in t ? t[p] : () => {
    rendered.push(name + '/' + p);
    w.document.getElementById('body').innerHTML = p === 'index' && name === 'Auth' ? '<a id="new-player-btn"></a>' : '';
  } });
  const auth = pages('Auth');
  auth.authManager = { logout: () => log.push('logout') };
  router.controllers.set('Auth', auth);
  router.controllers.set('Fleet', pages('Fleet'));
  const menu = {
    router,
    setNavItems: (i) => log.push('nav:' + i[0].label),
    disableCloseBtn() {}, showNav() {}, useOpaqueBackground() {}, hideAndClearDialoguePanel() {},
    setBodyContent: (h) => { w.document.getElementById('body').innerHTML = h; },
  };
  w.eval(inject);
  w.menuPage = menu;
  const $ = (id) => w.document.getElementById(id);
  const fire = (ms) => timers.filter((t) => t.live && t.ms === ms).forEach((t) => { t.live = false; t.f(); });
  return { w, router, log, rendered, timers, $, fire, html: () => $('body').innerHTML };
}

// ── the defect ──
{
  const g = game();
  check('hooked the instant menuPage is published', g.router.goto.__structsSavedAccount === true);
  for (const page of ['index', 'introduction', 'signupConnectingToCorporate1']) g.router.goto('Auth', page);
  check('refused sign-in: no page that leads to a new account', g.rendered.length === 0, g.rendered.join());
  check('refused sign-in: no New Player control', !/new-player|New Player/i.test(g.html()));
  check('shows a sign-in page', g.log.includes('nav:Signing In'));
  check('the menu page is not saved for the next launch', g.w.localStorage.getItem('currentMenuPage') === null);
  check('choices wait', g.$('saved-account-choices').classList.contains('hidden'));
  g.fire(4000);
  check('choices arrive', !g.$('saved-account-choices').classList.contains('hidden'));
}

// ── the file alone is enough (the boot failed before the state loaded) ──
{
  const g = game({ inMemory: false });
  g.router.goto('Auth', 'index');
  check('a key only in localStorage is protected too', g.rendered.length === 0 && !g.$('new-player-btn'));
}

// ── who must still see New Player ──
{
  const g = game({ account: false });
  g.router.goto('Auth', 'index');
  g.router.goto('Auth', 'signupConnectingToCorporate1');
  check('no account: New Player as ever', g.rendered.join() === 'Auth/index,Auth/signupConnectingToCorporate1', g.rendered.join());
}
{
  const g = game({ account: false });
  g.w.gameState.mnemonic = WORDS; // mid-signup: a key, no player yet
  g.router.goto('Auth', 'index');
  check('a key with no player is an unfinished signup', g.rendered.join() === 'Auth/index');
}
{
  const g = game({ persistence: false });
  g.router.goto('Auth', 'index');
  check('logging out reaches the title page', g.rendered.join() === 'Auth/index');
}
{
  const g = game();
  g.w.localStorage.setItem('gameState', '{"mnemo');
  g.w.gameState.mnemonic = null;
  g.router.goto('Auth', 'index');
  check('an unreadable save does not throw', g.rendered.join() === 'Auth/index');
}

// ── signed in: the title page cannot come back behind the menu ──
{
  const g = game({ signedIn: true, page: { controller: 'Auth', page: 'index', options: {} } });
  g.router.restore('Fleet', 'index');
  check('a saved title page restores as Fleet', g.rendered.join() === 'Fleet/index', g.rendered.join());
  check('...and is forgotten', JSON.parse(g.w.localStorage.getItem('currentMenuPage')).controller === 'Fleet');
  g.router.goto('Auth', 'index');
  check('signed in: the title page is Fleet', g.rendered.at(-1) === 'Fleet/index');
}
{
  const g = game({ signedIn: true, page: { controller: 'Fleet', page: 'scan', options: {} } });
  g.router.restore('Fleet', 'index');
  check('other pages restore untouched', g.rendered.join() === 'Fleet/scan', g.rendered.join());
}

// ── retrying ──
{
  const g = game();
  g.router.goto('Auth', 'index');
  g.fire(15000);
  check('retries by itself', g.log.includes('reload'));
  check('and backs off', g.w.sessionStorage.getItem('structsSignInRetries') === '1');
  g.router.goto('Auth', 'index');
  check('second wait is longer', g.timers.some((t) => t.live && t.ms === 30000) && !g.timers.some((t) => t.live && t.ms === 15000));
  g.router.restore('Fleet', 'index');
  check('a sign-in resets the backoff', g.w.sessionStorage.getItem('structsSignInRetries') === '0');
}
{
  const g = game();
  g.router.goto('Auth', 'index');
  g.$('saved-account-retry').click();
  check('Try Again reloads', g.log.filter((l) => l === 'reload').length === 1);
}
{
  const g = game();
  g.router.goto('Auth', 'index');
  g.$('saved-account-returning').click();
  check('Returning Player opens device activation', g.rendered.join() === 'Auth/loginActivateDevice');
  check('no reload under that form', !g.timers.some((t) => t.live));
  const signal = g.router.navigationSignal;
  g.router.goto('Auth', 'index');
  check('back from it: the sign-in page again, its work stopped', g.log.filter((l) => l === 'nav:Signing In').length === 2 && signal.aborted);
  check('a background refresh has no page to redraw', g.router.currentController === null);
}

// ── Log Out ──
{
  const g = game();
  g.router.goto('Auth', 'index');
  g.$('saved-account-logout').click();
  check('asks first, naming the player', g.$('saved-account-logout-title').textContent === 'Log out of player 1-194?' && !g.log.includes('logout'));
  check('no reload under the question', !g.timers.some((t) => t.live));
  g.$('saved-account-cancel').click();
  check('Cancel returns to signing in', !!g.$('saved-account-retry'));
  g.$('saved-account-logout').click();
  g.$('saved-account-confirm').click();
  g.$('saved-account-confirm').click();
  await tick(20);
  check('key file first, then logout, once',
    g.log.filter((l) => /^save|^logout/.test(l)).join() === 'save_identity_backup:backup:1-194,logout', g.log.join());
}
{
  const g = game({ backupFails: true });
  g.router.goto('Auth', 'index');
  g.$('saved-account-logout').click();
  g.$('saved-account-confirm').click();
  await tick(20);
  check('no key file, no logout', !g.log.includes('logout'));
  check('and it says so', /could not be saved/.test(g.$('saved-account-logout-error').textContent));
}

// ── composes with identity-backup.js, which wraps the same router ──
{
  const g = game({ inject: readFileSync(root + '/frontend/identity-backup.js', 'utf8') + '\n' + src });
  g.timers.filter((t) => t.ms === 50).forEach((t) => t.f());
  check('identity-backup still finds the router', g.router.goto.__structsIdentity === true);
  g.router.goto('Auth', 'index');
  check('both wraps: still no New Player', g.rendered.length === 0);
}

// ── shipped ahead of the bundle ──
{
  const html = readFileSync(root + '/frontend/index.html', 'utf8');
  const at = html.indexOf('src="saved-account.js"');
  check('index.html loads it before the bundle', at > 0 && at < html.indexOf('src="js/index.js"'));
}

console.log(failures ? `${failures} FAILED` : 'all passed');
process.exit(failures ? 1 : 0);
