// Will every asset these windows reference actually SHIP?
//
// This is the one question the rest of this directory structurally cannot ask.
// The jsdom harnesses and the static server both read `frontend/` off disk, so
// a file that exists in the working tree passes every check — and then is
// absent from the built app.
//
// That happened. `frontend/css/chat-rows.css` was hand-authored into a
// directory `scripts/sync.sh` DELETES and regenerates from the webapp
// submodule:
//
//     rm -rf "$FRONTEND_DIR/css" … ; cp -r "$WEBAPP_DIR/src/public/css" …
//
// so `make release` destroyed it, the binary shipped without it, both the raid
// rail and the Comms window rendered as unstyled divs, and the full suite
// stayed green through three rounds of "it still looks wrong".
//
//   node scripts/harness-tests/assets.test.mjs
import { readFileSync, readdirSync, existsSync } from 'fs';
import { execFileSync } from 'child_process';

let failures = 0;
const check = (name, ok, detail) => {
  console.log((ok ? '  ok ' : 'FAIL ') + name + (ok || detail == null ? '' : ' — ' + detail));
  if (!ok) failures++;
};

const root = process.cwd();

/* Is this path a build output?
 *
 * `.gitignore` is the authority, not a second copy of sync.sh's wipe list —
 * lines 2-10 already mirror it exactly, and a list maintained here would be one
 * more thing to drift. `git check-ignore` exits 0 when the path is ignored.
 */
function isGenerated(rel) {
  try {
    execFileSync('git', ['check-ignore', '-q', rel], { cwd: root });
    return true;
  } catch {
    return false;
  }
}

// Where sync.sh copies each generated directory FROM. A generated asset has to
// be one the webapp actually provides; anything else is a hand-authored file
// sitting in the blast radius.
const SOURCED_FROM = {
  'frontend/css/': 'structs-webapp/src/public/css/',
  'frontend/fonts/': 'structs-webapp/src/public/fonts/',
  'frontend/img/': 'structs-webapp/src/public/img/',
  'frontend/lottie/': 'structs-webapp/src/public/lottie/',
  'frontend/structicons/': 'structs-webapp/src/public/structicons/',
  'frontend/sui/': 'structs-webapp/src/js/sui/',
};

function upstreamFor(rel) {
  for (const [dir, src] of Object.entries(SOURCED_FROM)) {
    if (rel.startsWith(dir)) return src + rel.slice(dir.length);
  }
  // `frontend/js/` is webpack output plus a few explicit copies, not a straight
  // directory copy, so it has no single upstream path to compare against.
  return null;
}

const windows = readdirSync(root + '/frontend')
  .filter((f) => f.endsWith('.html') && !f.startsWith('_'))
  .sort();

console.log('— every referenced asset exists');
const refs = [];
for (const file of windows) {
  const html = readFileSync(`${root}/frontend/${file}`, 'utf8');
  for (const m of html.matchAll(/<(?:link|script)\b[^>]*?\b(?:href|src)="([^"]+)"/g)) {
    const url = m[1];
    // Remote and inline URLs are somebody else's problem.
    if (/^(https?:)?\/\//.test(url) || url.startsWith('data:')) continue;
    const rel = 'frontend/' + url.split('?')[0].replace(/^\.?\//, '');
    refs.push({ file, url, rel });
    check(`${file} → ${url}`, existsSync(`${root}/${rel}`), 'no such file');
  }
}
check(`${windows.length} windows scanned, ${refs.length} local assets`, refs.length > 0);

/* A generated asset must be one `sync.sh` can actually regenerate.
 *
 * This is the check that was missing. A hand-authored file inside a wiped
 * directory exists on disk, passes every other test, and is gone from the next
 * build — silently, because nothing else looks.
 */
console.log('\n— nothing hand-authored inside a generated directory');
const before = failures;
for (const { file, url, rel } of refs) {
  if (!isGenerated(rel)) continue;              // repo-owned; safe
  const upstream = upstreamFor(rel);
  if (!upstream) continue;                      // frontend/js — no 1:1 source
  check(`${file} → ${url} survives a sync`,
    existsSync(`${root}/${upstream}`),
    `${rel} is in a directory sync.sh wipes, and ${upstream} does not exist — `
    + 'move it to a repo-owned path (top-level frontend/, or frontend/vendor/)');
}
check('no window depends on a file the next build would delete', failures === before);

/* Harness artifacts must not ship.
 *
 * `frontendDist` is the whole `frontend/` directory, so anything sitting there
 * at build time is embedded — fixture data and a stubbed `__TAURI__` inside the
 * app bundle.
 *
 * The check is that the CLEANUP still exists, not that the files are absent
 * right now: every other suite in this directory needs them to be present, so
 * asserting their absence would make the suites mutually exclusive. What
 * protects a build is the `rm` in `build-frontend.sh`, which runs as
 * `beforeBuildCommand`. Guard that line instead.
 */
console.log('\n— harness artifacts cannot reach a build');
const buildScript = readFileSync(`${root}/scripts/build-frontend.sh`, 'utf8');
check('build-frontend.sh still deletes them before every build',
  /rm -f .*_harness\*.*\n?.*_fixtures\*|rm -f[^\n]*_harness\*[^\n]*_fixtures\*/.test(buildScript),
  'the rm in build-frontend.sh is what keeps fixtures out of the bundle');
// ...and that .gitignore covers them by GLOB. It listed each file by hand, and
// the list drifted: the two newest harnesses were tracked by accident.
const ignore = readFileSync(`${root}/.gitignore`, 'utf8');
check('.gitignore globs them rather than listing each one',
  /^frontend\/_harness\*$/m.test(ignore) && /^frontend\/_fixtures\*$/m.test(ignore));

console.log(failures ? `\n${failures} failing check(s)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
