// Federated text must never become markup.
//
// Chat renders words written by people on other homeservers — names, message
// bodies, topics, reaction keys, status lines. Every one of them reaches the
// DOM through `textContent` and `createElement`, and the day one reaches it
// through `innerHTML` is the day a stranger can put script in this window.
//
// chat.js says so in a comment at the top. A comment is a promise; this is
// the check. The same rule now applies to the raid window, which renders
// message rows of its own.
import { readFileSync } from 'fs';

let failures = 0;
const check = (label, ok, detail) => {
  if (ok) { console.log('  ok ' + label); return; }
  failures++;
  console.log('FAIL ' + label + (detail ? ' — ' + detail : ''));
};

const root = process.cwd();

// Windows that render text arriving from other homeservers.
// Windows that render text somebody else chose. Not only Matrix: a player's
// ON-CHAIN name is theirs to set, and Team Ops and the leaderboards render
// hundreds of other players' names.
const FEDERATED = [
  'frontend/chat.js',
  'frontend/chat-refs.js',
  'frontend/chat-complete.js',
  'frontend/chat-reactions.js',
  'frontend/chat-commands.js',
  'frontend/chat-work.js',
  'frontend/raidview.js',
  'frontend/board-pages.js',
  'frontend/board-gamestats.js',
  'frontend/playercard.js',
  'frontend/guildcard.js',
  'frontend/providercard.js',
];

// Ways a string becomes markup rather than text.
// `innerHTML = ''` empties a node. It puts nothing in, so it cannot put a
// stranger's words in — and treating it as an injection buries the lines that
// really do build markup under twenty that do not.
//
// Judged by capturing what is assigned, NOT by a negative lookahead: `\s*`
// backtracks to zero width, which moves the lookahead past the space so it
// never sees the `''` it was meant to exclude. The first version of this
// passed nothing and looked correct.
const EMPTY_ASSIGN = /^\s*(''|"" |""|``)\s*$/;
// The raid window builds two strings into markup, both examined:
//
//  - a shield icon from a locally computed state word, no remote input;
//  - the tooltip bubble, which DOES carry a player's on-chain name and is
//    defended by escaping each segment. That escaping is load-bearing, so it
//    has its own check below.
const ALLOWED_MARKUP = [
  /non_standard_icons\/shield_/,
  /dataset\.suiTooltip/,
];

// The board window paints HTML built in Rust (`mcp_board_html`). That is a
// deliberate sink, not an oversight — but it means the RUST side is what
// stands between a player's name and markup, so its escaper is checked there
// (`the_board_escaper_covers_every_breakout`) rather than here.
const SERVER_RENDERED = 'frontend/board.js';

const INJECTORS = [
  { name: 'innerHTML assignment', re: /\.innerHTML\s*=([^;\n]*)/g,
    ok: (m) => EMPTY_ASSIGN.test(m[1]) },
  { name: 'outerHTML assignment', re: /\.outerHTML\s*=/g },
  { name: 'insertAdjacentHTML', re: /insertAdjacentHTML\s*\(/g },
  { name: 'document.write', re: /document\s*\.\s*write\s*\(/g },
  { name: 'eval', re: /(^|[^.\w])eval\s*\(/g },
  { name: 'new Function', re: /new\s+Function\s*\(/g },
];

for (const file of FEDERATED) {
  const src = readFileSync(root + '/' + file, 'utf8');
  // Comments describe the rule; they are not breaches of it.
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, ''))
    .join('\n');

  for (const injector of INJECTORS) {
    const re = new RegExp(injector.re.source, 'g');
    const hits = [];
    let m;
    while ((m = re.exec(code))) {
      if (injector.ok && injector.ok(m)) continue;   // benign by inspection
      if (ALLOWED_MARKUP.some((a) => a.test(m[0]))) continue;
      hits.push(m[0].trim().slice(0, 60));
    }
    check(file + ' uses no ' + injector.name, hits.length === 0,
      hits.join(' | '));
  }
}

// And the check has to be able to fail, or it is decoration. A line that
// really does assign innerHTML must be caught by the same matcher.
{
  const sample = 'node.innerHTML = untrusted;';
  const clearing = "node.innerHTML = '';";
  const fires = (text) => INJECTORS.some((i) => {
    const re = new RegExp(i.re.source, 'g');
    let m;
    while ((m = re.exec(text))) {
      if (i.ok && i.ok(m)) continue;
      return true;
    }
    return false;
  });
  check('the matcher catches a real injection', fires(sample), sample);
  check('…and treats clearing a node as what it is', !fires(clearing), clearing);
  // …and does not fire on a comment describing one.
  const commented = '// never innerHTML = anything\n';
  const stripped = commented.split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  const quiet = !INJECTORS.some((i) => new RegExp(i.re.source, 'g').test(stripped));
  check('…and not on a comment about it', quiet, commented);
}

// The tooltip's escaping, which the allowance above depends on.
//
// A player's on-chain name reaches this path, and players choose their own
// names. If the escaping is ever dropped as redundant — a comment there used
// to claim the text was never user content — a name is script.
{
  const src = readFileSync(root + '/frontend/raidview.js', 'utf8');
  const bubble = src.slice(src.indexOf('bubble.innerHTML'), src.indexOf('bubble.innerHTML') + 200);
  check('the tooltip escapes every segment before joining',
    /\.map\(esc\)/.test(bubble), bubble.slice(0, 90));

  const escFn = src.slice(src.indexOf('function esc('), src.indexOf('function esc(') + 220);
  for (const ch of ['&', '<', '>', '"']) {
    check("…and esc handles " + ch, escFn.includes("'" + ch + "'"), escFn.slice(0, 120));
  }
}

// ── The windows that must never assign innerHTML at all ────────────────────
//
// These render text written by federated strangers — message bodies, display
// names, room names, topics — and they are safe by CONSTRUCTION rather than by
// escaping: they build every node with textContent. That is a much stronger
// property than "we remembered to escape", but it is invisible, so nothing
// stops a later edit from reaching for innerHTML "just here". This is what
// stops it. A CLEAR (`= ''`) is allowed: it writes no markup.
{
  console.log('\n— windows that never build markup');
  for (const file of ['frontend/chat.js', 'frontend/chat-refs.js', 'frontend/chat-complete.js', 'frontend/chat-reactions.js', 'frontend/chat-commands.js', 'frontend/chat-work.js', 'frontend/transfer.js']) {
    const code = readFileSync(root + '/' + file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
    const sinks = [];
    const re = /\.(innerHTML|outerHTML)\s*=([^;\n]*)/g;
    let m;
    while ((m = re.exec(code))) {
      if (m[1] === 'innerHTML' && EMPTY_ASSIGN.test(m[2])) continue;
      sinks.push(m[0].trim().slice(0, 60));
    }
    check(file + ' assigns no innerHTML', sinks.length === 0, sinks.join(' | '));
    // insertAdjacentHTML and document.write are the same sink wearing a
    // different name.
    check('…nor reaches the same sink another way',
      !/insertAdjacentHTML|document\.write\(/.test(code));
  }
}

// The one window that deliberately paints server-built HTML should still not
// be building any of its OWN from string literals.
{
  const src = readFileSync(root + '/' + SERVER_RENDERED, 'utf8');
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  const re = /\.innerHTML\s*=([^;\n]*)/g;
  const built = [];
  let m;
  while ((m = re.exec(code))) {
    if (EMPTY_ASSIGN.test(m[1])) continue;
    // A bare identifier is what Rust rendered; painting that is the point of
    // this window. A string literal would be markup this file invented.
    if (/['"`]/.test(m[1])) built.push(m[0].trim().slice(0, 60));
  }
  check(SERVER_RENDERED + ' builds no markup of its own from strings',
    built.length === 0, built.join(' | '));
}

// ── Comms must not be able to spend ─────────────────────────────────────────
// Chat renders text written by federated strangers. The transfer path is the
// one place in the app where believing that text costs real money, so three
// things have to stay true together. Any ONE of them regressing quietly turns
// a hostile message into a payment instruction.
{
  const mod = readFileSync(root + '/src-tauri/src/matrix/mod.rs', 'utf8');
  const pages = readFileSync(root + '/src-tauri/src/mcp/tools/board_pages.rs', 'utf8');
  // The Comms window is chat.js plus the sections extracted from it; the
// rules below hold across all of them.
const chat = ['chat.js', 'chat-refs.js', 'chat-complete.js', 'chat-reactions.js', 'chat-commands.js', 'chat-work.js']
  .map((f) => readFileSync(root + '/frontend/' + f, 'utf8')).join('\n');

  // 1. The gate on the command that actually moves funds. It is an explicit
  //    allowlist of window labels — the hand-off was designed AROUND it rather
  //    than through it. Two things must hold: the gate is still there, and
  //    Comms is not on it. The second is the one that matters; the list may
  //    legitimately grow (the focused Pay window is on it) but never to
  //    include a window that renders text written by strangers.
  const exec = pages.slice(pages.indexOf('pub async fn mcp_transfer_execute'));
  const gate = exec.slice(0, 800).match(/require_window\(&window,\s*&\[([^\]]*)\]/);
  check('mcp_transfer_execute is still gated by a window allowlist', !!gate,
    'the gate chat was designed around is gone');
  const allowed = gate ? gate[1].match(/"[^"]+"/g).map((x) => x.slice(1, -1)) : [];
  check('…which does not include Comms', !allowed.includes('chat'), allowed.join(', '));
  check('…and is a real list, not a wildcard',
    allowed.length > 0 && allowed.every((l) => /^[a-z]+$/.test(l)), allowed.join(', '));

  // 2. Comms hands over an ID, never a destination. If this command ever grew
  //    an address parameter, a crafted card could name where funds go.
  const open = mod.slice(mod.indexOf('pub async fn matrix_open_transfer'));
  const sig = open.slice(0, open.indexOf(')'));
  check('matrix_open_transfer takes no caller-supplied address',
    !/addr|address|to\s*:/i.test(sig), sig.replace(/\s+/g, ' ').slice(0, 120));
  check('matrix_open_transfer resolves the address from the chain',
    /(query_)?entity\("player"/.test(open.slice(0, 2000))
    && /primaryAddress/.test(open.slice(0, 2000)));

  // 3. The window side sends the id and nothing else.
  const call = chat.slice(chat.indexOf("invoke('matrix_open_transfer'"), )
    .slice(0, 90).replace(/\s+/g, ' ');
  check('chat sends only a player id to the transfer hand-off',
    /invoke\('matrix_open_transfer', \{ playerId: card\.id \}\)/.test(call), call);

  // 3b. Federated TEXT is sanitised as it enters. A bidi override in a message
// body would make `pay 1-195` read as a different id; the body, the edit and
// the reply fallback all pass through `identity::sanitize_body` in Rust, and
// no window ever renders `formatted_body` (the protocol's HTML surface).
{
  const client = readFileSync(root + '/src-tauri/src/matrix/client.rs', 'utf8');
  const sites = (client.match(/identity::sanitize_body\(/g) || []).length;
  check('message bodies, edits and reply fallbacks are sanitised at ingestion (3+ sites)', sites >= 3, String(sites));
  const windows = ['chat.js', 'chat-refs.js', 'chat-complete.js', 'chat-reactions.js', 'chat-commands.js', 'chat-work.js', 'chatrow.js', 'raidview.js', 'transfer.js']
    .map((f) => readFileSync(root + '/frontend/' + f, 'utf8')).join('\n');
  check('no window reads formatted_body', !/formatted_body/.test(windows));
  const ident = readFileSync(root + '/src-tauri/src/matrix/identity.rs', 'utf8');
  check('the body sanitiser keeps the emoji joiner (a family emoji is spelled with it)',
    /fn reorders_or_hides[\s\S]*?\}\n/.test(ident) && !/'\\u\{200D\}'/.test(ident.slice(ident.indexOf('fn reorders_or_hides'), ident.indexOf('pub fn sanitize_body'))));
}

// 4. The hand-off has to ARRIVE. The focused window claims the parked intent
  //    on boot AND listens for a re-address, because the ask usually OPENS the
  //    window and an event fired at a window that is still booting reaches
  //    nobody. An earlier version wired this on the board at module load —
  //    before `Board.T` existed — so it silently never registered and Pay
  //    appeared to do nothing at all.
  const tx = readFileSync(root + '/frontend/transfer.js', 'utf8');
  check('the Pay window claims whatever was parked for it',
    /invoke\('matrix_take_pending_transfer'\)/.test(tx));
  check('…and also answers a re-address while already open',
    /listen\('transfer-intent'/.test(tx));
  // The recipient is chain-resolved before it ever reaches this window; the
  // window must not offer a way to type one.
  check('the Pay window never lets a destination be typed',
    !/id="tx-to"/.test(readFileSync(root + '/frontend/transfer.html', 'utf8')));
  check('…it spends only what the SERVER previewed',
    /to: S\.preview\.to/.test(tx) && /amount: S\.preview\.amount/.test(tx));

  // 5. "all" means the EXACT balance, never the printed one.
  //
  // The ladder rounds to two decimals, so a balance of 9,400,000,999 ualpha
  // prints as "9.4Kg"; reading that off the screen and typing it back asks for
  // 9,400,000,000 and strands the rest. The control therefore carries a
  // base-unit override that bypasses the text parse — and typing has to clear
  // it, or editing the box would silently still send everything.
  // Spelled against the ASSET rather than a hardcoded `S.alpha`, since the
  // window sends guild tokens too. `transfer.test.mjs` asserts the behaviour
  // itself — that "all" spends the un-printable remainder as well — which is
  // the check that actually matters; this one just keeps the override present.
  check('the Pay window can send the whole balance exactly',
    /S\.exact = asset\(\)\.amount/.test(tx));
  check('…preferring that over anything parsed from the box',
    /S\.exact != null[\s\S]{0,80}baseUnits/.test(tx));
  check('…and typing takes the number back',
    /addEventListener\('input'[\s\S]{0,300}S\.exact = null/.test(tx));
  check('…as does a new recipient, and a completed send',
    (tx.match(/S\.exact = null/g) || []).length >= 3,
    String((tx.match(/S\.exact = null/g) || []).length));

  // 5. And it does not invoke the executing command at all. Comments are
  //    stripped first: this file NAMES that command in prose explaining why it
  //    stays out of reach, and the prose must not be what satisfies the check.
  const chatCode = chat
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  check('chat never invokes mcp_transfer_execute',
    !/mcp_transfer_execute/.test(chatCode));
}

// ── Remote media a stranger can point us at ────────────────────────────────
// An avatar_url or an image message is a URL chosen by whoever sent it. Three
// properties keep that from becoming a rendering hole, and all three are one
// edit away from being lost.
{
  console.log('\n— media from strangers');
  const client = readFileSync(root + '/src-tauri/src/matrix/client.rs', 'utf8');
  const types = client.match(/const MEDIA_OK_TYPES[^=]*=\s*&\[([^\]]*)\]/);
  check('media is restricted to an allowlist of types', !!types);
  const list = types ? types[1].match(/"[^"]+"/g).map((x) => x.slice(1, -1)) : [];
  // SVG is the one image type that carries script. An <img> will not run it
  // today, but the same data URL in a link or a frame would.
  check('…which excludes SVG', !list.includes('image/svg+xml'), list.join(', '));
  check('…and every entry is a raster image type',
    list.length > 0 && list.every((t) => /^image\/(png|jpeg|gif|webp|avif)$/.test(t)),
    list.join(', '));

  // The bytes are fetched by US and re-encoded, so the webview never resolves
  // a remote URL a stranger chose. Returning the mxc→http URL directly would
  // be the easy "simplification" that undoes this.
  const media = client.slice(client.indexOf('pub async fn media_data_url'));
  const body = media.slice(0, media.indexOf('\n}\n'));
  check('…and the window is handed re-encoded bytes, never a remote URL',
    /data:\{\};base64/.test(body.replace(/\s+/g, '')) || /format!\("data:\{\};base64/.test(body),
    'a remote URL reaching the webview is a fetch we did not make');
}

// ── A face is not something you can put on ─────────────────────────────────
// Matrix lets any account set any avatar, so if this client rendered the
// avatar_url of whoever sent a message, wearing a guildmate's face would be
// trivial. It does not: a portrait is drawn ONLY from the chain's
// pfpClientRenderAttributes, and anyone without an on-chain identity gets a
// placeholder that looks nothing like a person's portrait.
//
// That is a property held by construction, which makes it invisible — the
// obvious "improvement" is to fall back to the avatar we could easily fetch.
{
  console.log('\n— portraits');
  const client = readFileSync(root + '/src-tauri/src/matrix/client.rs', 'utf8');
  const assigns = [...client.matchAll(/pfp_attrs:\s*([^,\n]+)/g)].map((m) => m[1].trim());
  const sourced = assigns.filter((a) => a !== 'None' && !a.startsWith('Option<'));
  check('every portrait comes from an on-chain identity or from nothing',
    sourced.length > 0 && sourced.every((a) => /ident\.as_ref\(\)/.test(a)),
    sourced.join(' | '));

  const chat = ['chat.js', 'chat-refs.js', 'chat-complete.js', 'chat-reactions.js', 'chat-commands.js', 'chat-work.js']
    .map((f) => readFileSync(root + '/frontend/' + f, 'utf8')).join('\n');
  const srcs = [...chat.matchAll(/\.src\s*=\s*([^;\n]+)/g)].map((m) => m[1].trim());
  // Everything the window points an <img> at is either a bundled path built
  // from a literal, or bytes we fetched and re-encoded ourselves. A bare
  // field off a message would be a URL a stranger chose.
  const remote = srcs.filter((x) => !x.startsWith("'img/") && !/data_url/.test(x));
  check('…and no image is pointed at a URL from message data',
    remote.length === 0, remote.join(' | '));
}

// ── Names the app trusts outright ──────────────────────────────────────────
// An on-chain name renders with NO player id beside it, because the chain
// settles who owns it. That makes it the most trusted string in the app, and
// the chain says nothing about whether it can be read — a registered name can
// still carry a bidi override. Sanitizing happens where identities are
// ingested, so every surface downstream inherits it.
{
  console.log('\n— owned names');
  const dir = readFileSync(root + '/src-tauri/src/matrix/directory.rs', 'utf8');
  const usernames = [...dir.matchAll(/username:\s*([^,\n]+)/g)]
    .map((m) => m[1].trim())
    .filter((v) => v !== 'String');            // the struct field declaration
  check('every on-chain name is sanitized as it is ingested',
    usernames.length > 0 && usernames.every((v) => /identity::sanitize/.test(v)),
    usernames.join(' | '));

  // The leaderboard reads its own identities from the guild rosters rather
  // than through the Comms directory, so it is a separate ingestion path with
  // the same problem.
  const stats = readFileSync(root + '/src-tauri/src/mcp/game_stats.rs', 'utf8');
  const ident = stats.slice(stats.indexOf('Identity {', stats.indexOf('identities.insert')));
  const fields = [...ident.slice(0, 1400).matchAll(/(username|guild_name|tag):\s*([^,\n]+)/g)];
  check('…including the ones the leaderboard renders',
    fields.length > 0 && fields.every((m) => /identity::sanitize/.test(m[2])),
    fields.map((m) => m[1] + ': ' + m[2]).join(' | '));
}

// ── Only a person speaking may interrupt you ───────────────────────────────
// Reported from live play: signing in produced a desktop notification reading
// "<name> joined", every time. A DM notified on anything that was not
// `unknown`, and joins, renames, topic changes, pins and invitations all
// render as kind `event`.
//
// Checked against the SOURCE, not a copy of the list: a Rust test asserting its
// own local closure passes happily while the real filter regresses.
{
  console.log('\n— what may raise a notification');
  const client = readFileSync(root + '/src-tauri/src/matrix/client.rs', 'utf8');
  const fn = client.slice(client.indexOf('fn maybe_notify('));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  const m = /matches!\(m\.kind,([^)]*)\)/.exec(body);
  check('the notifier uses an allowlist of kinds', !!m,
    'a `kind != "unknown"` filter lets a join interrupt you');
  const kinds = m ? m[1].match(/"[a-z]+"/g).map((x) => x.slice(1, -1)).sort() : [];
  check('…which is exactly text, emote and image',
    kinds.join(',') === 'emote,image,text', kinds.join(','));
  // `notice` is both a real m.notice and this file's own synthesized lines
  // ("message removed", a tombstone, an unreadable encrypted message).
  check('…and never event, notice or gap',
    !kinds.includes('event') && !kinds.includes('notice') && !kinds.includes('gap'),
    kinds.join(','));
}

console.log(failures ? `\n${failures} failing check(s)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
