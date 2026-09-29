// frontend/identity-backup.js against a fake router, Auth controller and
// Tauri bridge: the recovery-key screens are never rendered, the key file is
// written BEFORE the account is created, and any failure hands the player
// back to the webapp's own screens.
import { readFileSync } from 'fs';
import { JSDOM } from 'jsdom';

let failures = 0;
const check = (name, ok, detail) => {
  console.log((ok ? '  ok ' : 'FAIL ') + name + (ok || detail == null ? '' : ' — ' + detail));
  if (!ok) failures++;
};
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const root = process.cwd().replace(/\/scripts\/harness-tests$/, '');
const src = readFileSync(root + '/frontend/identity-backup.js', 'utf8');
const WORDS = 'apple mask lens scout acid exclude evolve double build theme tone enlist';

function game({ saveFails = false, signupOk = true, mode = 'DEFAULT', hasMnemonic = false } = {}) {
  const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' });
  const w = dom.window;
  const log = [];
  const rendered = [];
  const auth = {
    walletManager: { createMnemonic: () => { log.push('createMnemonic'); return WORDS; } },
    authManager: { signup: async (m) => { log.push('signup:' + m); return signupOk; } },
  };
  const router = {
    mode,
    controllers: new Map([['Auth', auth]]),
    goto(c, p) { rendered.push(c + '/' + p); },
  };
  w.gameState = {
    mnemonic: hasMnemonic ? WORDS : null,
    signupRequest: { username: 'Ace' },
    thisGuild: { id: '0-1' },
    save() { log.push('save'); },
  };
  w.__TAURI__ = { core: { invoke: async (cmd, args) => {
    log.push(cmd + ':' + args.dest);
    w.lastArgs = args;
    if (saveFails) throw new Error('disk full');
    return { path: '/x' };
  } } };
  w.console.warn = () => {};
  w.eval(src);
  w.menuPage = { router };
  return { w, router, log, rendered };
}

// ── happy path ──
{
  const g = game();
  await tick(80);
  check('installs on menuPage.router', g.router.goto.__structsIdentity === true);
  g.router.goto('Auth', 'signupSetUsername');
  g.router.goto('Auth', 'signupRecoveryKeyIntro');
  await tick(10);
  check('never renders a recovery-key screen',
    !g.rendered.some((r) => /RecoveryKey|signupSuccess/.test(r)), g.rendered.join(', '));
  check('shows Connecting… straight from the username screen',
    g.rendered.join(',') === 'Auth/signupSetUsername,Auth/loggingIn', g.rendered.join(', '));
  check('file first, then signup, then save',
    g.log.join(',') === `createMnemonic,save_identity_backup:backup,signup:${WORDS},save`, g.log.join(', '));
  check('file carries username and guild', g.w.lastArgs.username === 'Ace' && g.w.lastArgs.guildId === '0-1');
  check('mnemonic kept on gameState', g.w.gameState.mnemonic === WORDS);
  g.router.goto('Auth', 'signupSuccess');
  check('a late signupSuccess is swallowed too', !g.rendered.includes('Auth/signupSuccess'));
  g.router.goto('Auth', 'orientation1');
  check('other pages pass through', g.rendered.at(-1) === 'Auth/orientation1');
}

// ── an existing mnemonic is reused ──
{
  const g = game({ hasMnemonic: true });
  await tick(80);
  g.router.goto('Auth', 'signupRecoveryKeyCreation');
  await tick(10);
  check('restored mid-flow: reuses the mnemonic, no new one', !g.log.includes('createMnemonic'));
  check('restored mid-flow: still skips', !g.rendered.includes('Auth/signupRecoveryKeyCreation'));
}

// ── save fails → no account, original screens ──
{
  const g = game({ saveFails: true });
  await tick(80);
  g.router.goto('Auth', 'signupRecoveryKeyIntro');
  await tick(10);
  check('file failed: no signup', !g.log.some((l) => l.startsWith('signup')), g.log.join(', '));
  check('file failed: falls back to the intro', g.rendered.at(-1) === 'Auth/signupRecoveryKeyIntro');
  g.router.goto('Auth', 'signupRecoveryKeyCreation');
  check('file failed: later screens render normally', g.rendered.at(-1) === 'Auth/signupRecoveryKeyCreation');
}

// ── signup refused → original screens ──
{
  const g = game({ signupOk: false });
  await tick(80);
  g.router.goto('Auth', 'signupRecoveryKeyIntro');
  await tick(10);
  check('signup refused: no gameState.save', !g.log.includes('save'));
  check('signup refused: falls back to the intro', g.rendered.at(-1) === 'Auth/signupRecoveryKeyIntro');
}

// ── preview mode is left alone ──
{
  const g = game({ mode: 'PREVIEW' });
  await tick(80);
  g.router.goto('Auth', 'signupRecoveryKeyCreation');
  check('preview mode renders the real page', g.rendered.at(-1) === 'Auth/signupRecoveryKeyCreation' && g.log.length === 0);
}

console.log(failures ? `\n${failures} failure(s)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
