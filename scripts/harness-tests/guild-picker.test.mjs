// frontend/guild-picker.js against the webapp's real router and offcanvas, with
// the real guild card: the chip says which guild the app is pointed at, the
// directory lists and finds guilds, and picking one switches and comes back.
import { readFileSync } from 'fs';
import { JSDOM } from 'jsdom';

let failures = 0;
const check = (name, ok, detail) => {
  console.log((ok ? '  ok ' : 'FAIL ') + name + (ok || detail == null ? '' : ' — ' + detail));
  if (!ok) failures++;
};
const tick = () => new Promise((r) => setTimeout(r, 5));
const root = process.cwd().replace(/\/scripts\/harness-tests$/, '');
const read = (p) => readFileSync(root + '/' + p, 'utf8');
const routerSrc = read('structs-webapp/src/js/framework/MenuPageRouter.js')
  .replace(/^import .*$/m, "const MENU_PAGE_ROUTER_MODES = { DEFAULT: 'DEFAULT', PREVIEW: 'PREVIEW' };")
  .replace('export class', 'window.MenuPageRouter = class');
const offSrc = read('structs-webapp/src/js/sui/SUIOffcanvas.js')
  .replace(/^import .*$/m, 'class SUIFeature {}')
  .replace('export class', 'window.SUIOffcanvas = class');

const LISTINGS = [
  { id: '0-5', name: 'SN Corp', tag: 'SN.C', logo: null, description: 'We know better.', members: 9463, recruiting: false },
  { id: '0-1', name: 'Orbital Hydro', tag: 'OH', logo: 'https://oh.energy/images/logo.svg', description: '', members: 5067, recruiting: false },
  { id: '0-8', name: 'Rekt Gang', tag: 'REKT', logo: null, description: '<img src=x onerror=1>', members: 14, recruiting: true },
  { id: '0-11', name: 'Bad Kids', tag: 'BAD', logo: null, description: 'Bad Kids', members: null, recruiting: true },
];

function game({ guild = '0-5', account = false, returnTo = null, fail = {}, listings = LISTINGS } = {}) {
  const dom = new JSDOM('<!doctype html><body><div id="body"></div></body>', { url: 'http://localhost/', runScripts: 'outside-only' });
  const w = dom.window;
  const log = [];
  w.console.warn = () => {};
  w.console.info = () => {};
  w.__STRUCTS_CONFIG__ = { guildId: guild, name: guild === '0-5' ? 'SN Corp' : 'Somewhere', guildTag: 'SN.C', guildApi: 'https://beta.playstructs.com/api' };
  if (returnTo) w.sessionStorage.setItem('structsGuildPage', returnTo);
  if (account) w.localStorage.setItem('gameState', JSON.stringify({ mnemonic: 'a b c', thisPlayerId: '1-194' }));
  w.__TAURI__ = { core: { invoke: async (cmd, a) => {
    log.push([cmd, a]);
    if (fail[cmd]) throw new Error('no');
    return cmd === 'guild_listings' ? JSON.parse(JSON.stringify(listings)) : cmd === 'follow_saved_player' ? 'current' : null;
  } } };
  w.gameState = { persistenceEnabled: true, mnemonic: null, keyPlayers: { player: {} } };
  w.eval(routerSrc);
  w.eval(offSrc);
  w.eval(read('frontend/saved-account.js').replace('window.location.reload();', ''));
  w.eval(read('frontend/playercard.js'));
  w.eval(read('frontend/guildcard.js'));
  w.eval(read('frontend/guild-picker.js'));

  const body = w.document.getElementById('body');
  const HTML = {
    index: '<div class="justified-centered"><img class="glitch-logo"><a id="new-player-btn"></a><a id="returning-player-btn"></a></div>',
    loginActivateDevice: '<div class="login-activate-device-layout"><div>text</div></div>',
    loginRecoverAccountStart: '<div class="common-layout-col mod-justify-start"><div>text</div></div>',
    signupConnectingToCorporate1: '<div class="justified-centered">connecting</div>',
  };
  const rendered = [];
  const router = new w.MenuPageRouter();
  router.controllers.set('Auth', new Proxy({}, { get: (t, p) => () => { rendered.push(p); body.innerHTML = HTML[p] || ''; } }));
  router.controllers.set('Fleet', { index: () => { rendered.push('Fleet'); body.innerHTML = ''; } });
  const oc = new w.SUIOffcanvas();
  oc.autoInitAll();
  w.menuPage = {
    router, sui: { offcanvas: oc },
    setNavItems() {}, disableCloseBtn() {}, showNav() {}, useOpaqueBackground() {}, hideAndClearDialoguePanel() {},
    setBodyContent: (h) => { body.innerHTML = h; },
  };
  const $ = (s) => w.document.querySelector(s);
  const $$ = (s) => [...w.document.querySelectorAll(s)];
  const text = (n) => (n ? n.textContent.replace(/\s+/g, ' ').trim() : '');
  const calls = (c) => log.filter((x) => x[0] === c);
  return { w, router, body, rendered, log, oc, $, $$, text, calls };
}

console.log('— the chip');
{
  const g = game();
  check('both wraps are on, ours outside', g.router.goto.__structsGuildPicker === true);
  g.router.goto('Auth', 'index');
  const chip = g.$('.gp-chip');
  check('drawn before the directory answers', /SN Corp/.test(g.text(chip)), g.text(chip));
  check('above New Player', chip && chip.nextElementSibling.id === 'new-player-btn');
  await tick();
  check('one chip, once the directory answers', g.$$('.gp-chip').length === 1);
  check('keyboard reaches it', g.$('.gp-chip').getAttribute('role') === 'button' && g.$('.gp-chip').tabIndex === 0);
  for (const p of ['loginActivateDevice', 'loginRecoverAccountStart']) {
    g.router.goto('Auth', p);
    const row = g.$('.gp-here');
    check(p + ': the guild is the first thing on the page', row && row === row.parentNode.firstElementChild);
    check(p + ': with its count', /9,463/.test(g.text(row)), g.text(row));
  }
  g.router.goto('Auth', 'signupConnectingToCorporate1');
  check('not on a page that is already talking to a guild', !g.$('.gp-chip, .gp-here'));
  check('the directory is read once for all of them', g.calls('guild_listings').length === 1);
}

console.log('— the directory');
{
  const g = game();
  g.router.goto('Auth', 'index');
  await tick();
  g.$('.gp-chip').click();
  await tick();
  check('opens on the right', g.oc.offcanvasElm.classList.contains('sui-mod-right') && !g.oc.offcanvasElm.classList.contains('sui-mod-left'));
  check('every guild, in the order given', g.$$('.gp-row').map((r) => r.dataset.guildId).join() === '0-5,0-1,0-8,0-11');
  check('the current one is marked', g.$$('.gp-row[aria-current]').length === 1 && g.$('.gp-row[aria-current]').dataset.guildId === '0-5');
  check('only recruiting guilds are Open', g.$$('.gp-row .sui-badge').length === 2);
  check('a guild\'s words are text, never markup', !g.$('.gp-row .sui-text-tiny img') && /onerror/.test(g.text(g.$$('.gp-row')[2])));
  check('an uncounted guild shows no number', !g.$$('.gp-row')[3].querySelector('.pc-res'));
  const input = g.$('.gp-find input');
  const find = (v) => { input.value = v; input.dispatchEvent(new g.w.Event('input')); return g.$$('.gp-row').map((r) => r.dataset.guildId).join(); };
  check('found by name', find('hydro') === '0-1');
  check('found by tag', find('REKT') === '0-8');
  check('nothing found says so', find('zzz') === '' && g.text(g.$('.gp-note')) === 'No guilds');
  g.oc.close();
  check('closing puts the game\'s offcanvas back', g.oc.offcanvasElm.classList.contains('sui-mod-left') && !g.oc.offcanvasElm.classList.contains('gp-open'));
  g.$('.gp-chip').click();
  await tick();
  g.$('.gp-row[aria-current]').click();
  check('picking the guild it is already on only closes', g.calls('apply_guild_switch').length === 0 && g.oc.offcanvasElm.classList.contains('hidden'));
  g.$('.gp-chip').click();
  g.router.goto('Auth', 'loginActivateDevice');
  check('navigating closes it', !g.oc.offcanvasElm.classList.contains('gp-open'));
}

console.log('— picking');
{
  const g = game();
  g.router.goto('Auth', 'loginActivateDevice');
  await tick();
  g.$('.gp-here').click();
  await tick();
  g.$$('.gp-row')[2].click();
  g.$$('.gp-row').forEach((r) => r.click());
  await tick();
  check('switches once, to that guild', g.calls('apply_guild_switch').length === 1 && g.calls('apply_guild_switch')[0][1].guildId === '0-8');
  check('remembers the page', g.w.sessionStorage.getItem('structsGuildPage') === 'loginActivateDevice');
  check('says so', g.text(g.$('.gp-note')) === 'Connecting to Rekt Gang');

  const back = game({ guild: '0-8', returnTo: 'loginActivateDevice' });
  back.router.goto('Auth', 'index');
  check('comes back to it', back.rendered.join() === 'loginActivateDevice');
  check('once', back.w.sessionStorage.getItem('structsGuildPage') === null);
  back.router.goto('Auth', 'index');
  check('Back still reaches the title', back.rendered.join() === 'loginActivateDevice,index');

  const odd = game({ returnTo: 'signupSetUsername' });
  odd.router.goto('Auth', 'index');
  check('never to a page it does not own', odd.rendered.join() === 'index');

  const f = game({ fail: { apply_guild_switch: true } });
  f.router.goto('Auth', 'index');
  await tick();
  f.$('.gp-chip').click();
  await tick();
  f.$$('.gp-row')[1].click();
  await tick();
  check('a failed switch says so and leaves nothing behind',
    /Could not connect to Orbital Hydro/.test(f.text(f.$('.gp-note'))) && f.w.sessionStorage.getItem('structsGuildPage') === null);
  f.$('.gp-chip').click();
  f.oc.close(); f.$('.gp-chip').click();
  await tick();
  check('and can be tried again', f.$$('.gp-row').length === 4);

  const d = game({ fail: { guild_listings: true } });
  d.router.goto('Auth', 'index');
  await tick();
  d.$('.gp-chip').click();
  await tick();
  check('an unreadable directory says so', /could not be read/.test(d.text(d.$('.gp-note'))));
}

console.log('— the saved account');
{
  const g = game({ account: true });
  await tick();
  const c = g.calls('follow_saved_player');
  check('its guild is checked as the window loads', c.length === 1 && c[0][1].playerId === '1-194');
  check('against what the window is about to sign in with', c[0] && c[0][1].running.guildId === '0-5');
  g.router.goto('Auth', 'index');
  check('New Player and its chip stay off', !g.$('.gp-chip') && g.rendered.length === 0);
  g.router.goto('Auth', 'loginActivateDevice');
  check('Returning Player has the guild', !!g.$('.gp-here'));

  const p = game({ account: true, guild: '0-8', returnTo: 'loginActivateDevice' });
  await tick();
  check('a guild just picked is not corrected away', p.calls('follow_saved_player').length === 0);
  p.router.goto('Auth', 'index');
  check('and the page comes back', p.rendered.join() === 'loginActivateDevice');

  const none = game();
  await tick();
  check('no account, no check', none.calls('follow_saved_player').length === 0);
}

console.log('— wiring');
{
  const html = read('frontend/index.html');
  const at = (s) => html.indexOf('src="' + s + '"');
  check('loads after saved-account, before the bundle',
    at('saved-account.js') > 0 && at('saved-account.js') < at('playercard.js') && at('playercard.js') < at('guildcard.js')
    && at('guildcard.js') < at('guild-picker.js') && at('guild-picker.js') < at('js/index.js'));
  for (const f of ['playercard.css', 'guildcard.css', 'guild-picker.css']) check(f + ' is linked', html.includes('href="' + f + '"'));
  const main = read('src-tauri/src/main.rs');
  for (const c of ['apply_guild_switch', 'guild_listings', 'follow_saved_player']) check(c + ' is a command', main.includes('guild_directory::' + c + ','));
  check('the game asks for the configured guild, not the server\'s host',
    read('scripts/apply-patches.sh').includes('guild/${window.__STRUCTS_CONFIG__?.guildId'));
  check('the call that patch rewrites is still there', read('structs-webapp/src/js/api/GuildAPI.js').includes('`${this.apiUrl}/guild/this`'));
}

console.log(failures ? failures + ' failed' : 'all passed');
process.exit(failures ? 1 : 0);
