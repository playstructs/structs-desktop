#!/usr/bin/env node
// The Matrix contract: every call the frontend makes matches the Rust command
// it is calling, every event the frontend listens for is one Rust emits with
// the keys it reads, every reply key a callback reads is one Rust answers,
// and every command a page uses over the web has a web-board arm.
//
// Derived from `src-tauri/src/matrix/mod.rs` and `web_board.rs` rather than
// written down: a signature that changes, or a call written from memory,
// fails here instead of in somebody's conversation.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..');
const read = (p) => readFileSync(resolve(repo, p), 'utf8');
// Every page that speaks to Rust about Matrix: the Comms window and its
// modules, the raid rail, the board's unread door, the Terminal's words.
const FRONTEND = ['frontend/chat.js', 'frontend/chat-refs.js', 'frontend/chat-complete.js', 'frontend/chat-reactions.js',
  'frontend/chat-commands.js', 'frontend/chat-work.js', 'frontend/chat-channels.js', 'frontend/chat-search.js',
  'frontend/chat-people.js', 'frontend/chat-connection.js', 'frontend/chat-pins.js', 'frontend/chat-presence.js',
  'frontend/chat-message.js', 'frontend/chat-scroll.js', 'frontend/chat-room.js', 'frontend/chat-tabs.js',
  'frontend/chat-rent.js', 'frontend/raidview-comms.js', 'frontend/board.js', 'frontend/board-terminal.js'];

let failures = 0;
function check(what, ok, detail) {
  if (!ok) failures++;
  console.log((ok ? '  ok ' : 'FAIL ') + what + (ok || detail == null ? '' : ' — ' + detail));
}

// So the shapes are derived FROM `src-tauri/src/matrix/mod.rs` and compared to
// what the frontend really sends. A signature that changes, or a call written
// from memory, fails here instead of in somebody's conversation.
{
  console.log('\n— every call matches the command it is calling');
  const rust = read('src-tauri/src/matrix/mod.rs');
  const sig = {};
  for (const m of rust.matchAll(/pub (?:async )?fn (matrix_\w+)\(([^)]*)\)/g)) {
    sig[m[1]] = m[2].split(',').map((a) => a.trim().split(':')[0].trim())
      .filter((a) => a && a !== 'app');
  }
  const snake = (k) => k.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());
  const js = [];
  for (const f of FRONTEND) {
    const src = read(f);
    /* The TOP-LEVEL keys of the argument object, by walking it: `replyTo:
     * {event_id, sender}` is one key, and `draft: a ? b.text : null` is one
     * key called draft — a `(\w+):` regex read both as several. */
    for (const m of src.matchAll(/invoke\('(matrix_\w+)',\s*\{/g)) {
      let i = m.index + m[0].length, depth = 1, seg = '', segs = [];
      while (i < src.length && depth) {
        const c = src[i];
        if (c === '{' || c === '(' || c === '[') depth++;
        else if (c === '}' || c === ')' || c === ']') depth--;
        if (depth === 0) break;
        if (c === ',' && depth === 1) { segs.push(seg); seg = ''; } else seg += c;
        i++;
      }
      segs.push(seg);
      const keys = segs.map((t) => t.trim()).filter(Boolean).map((t) => t.split(':')[0].trim()).filter((k) => /^\w+$/.test(k));
      js.push({ cmd: m[1], keys: keys.map(snake), file: f });
    }
  }
  check('every matrix command the cards call actually exists',
    js.every((c) => sig[c.cmd]), js.filter((c) => !sig[c.cmd]).map((c) => c.cmd).join(','));

  /* A key Rust does not take is silently dropped by serde; a key it REQUIRES
   * and does not get is a deserialisation failure — the whole call. Only
   * `Option<_>` parameters may be omitted. */
  const optional = {};
  for (const m of rust.matchAll(/pub (?:async )?fn (matrix_\w+)\(([^)]*)\)/g)) {
    optional[m[1]] = new Set(
      m[2].split(',').filter((a) => /:\s*Option</.test(a))
        .map((a) => a.trim().split(':')[0].trim()));
  }
  const missing = js.flatMap((c) => (sig[c.cmd] || [])
    .filter((p) => !optional[c.cmd].has(p) && !c.keys.includes(p))
    .map((p) => c.cmd + ' needs ' + p));
  check('…and passes every argument that is not optional',
    missing.length === 0, [...new Set(missing)].join(' · '));

  const unknown = js.flatMap((c) => c.keys.filter((k) => !(sig[c.cmd] || []).includes(k))
    .map((k) => c.cmd + ' has no ' + k));
  check('…and invents none that the command does not take',
    unknown.length === 0, [...new Set(unknown)].join(' · '));

  /* The OTHER half, and the half that produced the typing and presence bugs.
   *
   * Rust pushes `matrix::typing` with `names` and the model read `user_ids`;
   * `matrix::presence` with a `presence` MAP and the model read `p.user_id`.
   * Both fail silently — a handler that reads a key nobody sent gets undefined
   * and carries on, so the indicator simply never appears and nothing anywhere
   * says why. Derived from the emit sites the same way the calls are. */
  /* THE REPLY. What a command hands back is a shape too, and a card that
   * reads `d.pinned` from a command that answers `{room_id, messages}` gets
   * undefined and draws nothing — the same silent failure as a bad call, one
   * hop later. Derived from every `Ok(json!({…}))` in the command's body;
   * a command that answers an opaque value (`Ok(out)`) is not judged. A line
   * that reads a fallback chain (`d.pinned || d.messages`) passes when ANY
   * key on it is real. */
  const replies = {};
  for (const m of rust.matchAll(/pub (?:async )?fn (matrix_\w+)\([\s\S]*?\n\}/g)) {
    const name = m[1];
    const body = m[0];
    const keys = new Set();
    let shaped = false;
    for (const j of body.matchAll(/Ok\(json!\(\{([\s\S]*?)\}\)\)/g)) {
      shaped = true;
      for (const k of j[1].matchAll(/"(\w+)"\s*:/g)) keys.add(k[1]);
    }
    if (/Ok\((?!json!)\w+\)/.test(body)) shaped = false; // an opaque answer somewhere: skip
    if (shaped) replies[name] = keys;
  }
  /* Reads a card makes ON PURPOSE of a key today's answer lacks, each with
   * its reason. A new one is a decision, not a fallback. */
  const hopeful = {
    // join answers {ok} and the room arrives on the NEXT sync; the read is
    // for a homeserver that names the room at once, and afterJoin builds
    // the provisional room without it.
    matrix_join: new Set(['room_id', 'roomId']),
  };
  const badReads = [];
  for (const f of FRONTEND) {
    const src = read(f);
    // Only a `.then` chained straight onto the invoke is judged: one hop
    // later the value may be somebody else's promise.
    for (const m of src.matchAll(/invoke\('(matrix_\w+)',\s*\{[^}]*\}\)\s*\.then\(function \((\w+)\)\s*\{/g)) {
      const cmd = m[1], v = m[2];
      if (!replies[cmd]) continue;
      // The callback body: up to the first line that closes it at its own depth.
      const tail = src.slice(m.index + m[0].length);
      let depth = 1, i = 0;
      for (; i < tail.length && depth > 0; i++) { if (tail[i] === '{') depth++; else if (tail[i] === '}') depth--; }
      const cb = tail.slice(0, i);
      for (const line of cb.split('\n')) {
        const reads = [...line.matchAll(new RegExp('\\b' + v + '\\.(\\w+)', 'g'))].map((r) => r[1]);
        if (!reads.length) continue;
        if (reads.every((k) => hopeful[cmd] && hopeful[cmd].has(k))) continue;
        if (!reads.some((k) => replies[cmd].has(k))) badReads.push(cmd + ' answers no ' + reads.join('/') + ' (' + f.split('/').pop() + ')');
      }
    }
  }
  check('every key a card reads from a reply is one the command answers',
    badReads.length === 0, [...new Set(badReads)].join(' · '));
  check('…judged on real shapes', Object.keys(replies).length >= 8, Object.keys(replies).length + ' shaped');

  /* The web board. The board is served at /board over HTTP, where an
   * invoke is a POST the Rust router has to have an arm for. Commands with
   * no arm answer `unknown command` and the page quietly draws nothing. Connect, disconnect and share are absent on purpose
   * — the arm's own comment says why — and are the only exceptions. */
  const web = read('src-tauri/src/mcp/web_board.rs');
  const routed = new Set([...web.matchAll(/"(matrix_\w+)"\s*=>/g)].map((m) => m[1]));
  const deliberate = new Set(['matrix_connect', 'matrix_disconnect', 'matrix_share']);
  /* Only the pages the web board SERVES: the board, the Terminal and the raid
   * view's rail. The Comms window is a native window and is never framed
   * over HTTP, so its work-offer, agreement and presence calls need no arm. */
  const WEB_SERVED = ['frontend/board.js', 'frontend/board-terminal.js', 'frontend/raidview-comms.js'];
  const unrouted = [...new Set(js.filter((c) => WEB_SERVED.includes(c.file)).map((c) => c.cmd))]
    .filter((c) => !routed.has(c) && !deliberate.has(c));
  check('every command the cards call has a web-board arm (or is excluded on purpose)',
    unrouted.length === 0, unrouted.join(','));

  const emits = {};
  const opaque = new Set();
  for (const f of ['src-tauri/src/matrix/mod.rs', 'src-tauri/src/matrix/client.rs']) {
    const rs = read(f);
    // Every event name that is emitted at all, however its payload is built.
    for (const m of rs.matchAll(/"(matrix::\w+)"/g)) emits[m[1]] = emits[m[1]] || new Set();
    // The ones whose payload is a literal right there.
    for (const m of rs.matchAll(/"(matrix::\w+)",\s*\n?\s*json!\(\{([\s\S]{0,400}?)\}\)/g)) {
      for (const k of m[2].matchAll(/"(\w+)"\s*:/g)) emits[m[1]].add(k[1]);
    }
    /* And the ones whose payload is built into a variable first — `let payload
     * = …; emit(…, p)` — or handed a whole function's return, like
     * `status_payload_as()`. Their keys cannot be read from the emit site, so
     * the KEY check is skipped for them rather than guessed at: a check that
     * invents an answer is worse than one that admits it does not know. */
    for (const m of rs.matchAll(/"(matrix::\w+)",\s*\n?\s*(?!json!\(\{)[a-z_]/g)) opaque.add(m[1]);
  }
  /* Handlers by BRACE-MATCHING, not by regex. A non-greedy match to the block
   * close ran a one-line handler on into the next one and blamed its keys on
   * the wrong event — `matrix::edited has no count`, when `count` was read by
   * the `matrix::unread` handler beneath it. */
  /* Every listener in the Comms window, the rail and the board. A handler
   * reads the payload as `e.payload.key`, or through an alias it takes first
   * (`var p = e && e.payload`); both spellings are followed. */
  const handlers = [];
  for (const f of FRONTEND) {
    const src = read(f);
    for (const m of src.matchAll(/listen\('(matrix::\w+)',\s*function\s*\((\w+)\)\s*\{/g)) {
      let i = m.index + m[0].length, depth = 1;
      while (i < src.length && depth) { if (src[i] === '{') depth++; else if (src[i] === '}') depth--; i++; }
      const body = src.slice(m.index + m[0].length, i - 1);
      const arg = m[2];
      const aliases = [...body.matchAll(/(?:var|const|let)\s+(\w+)\s*=[^;]*\bpayload\b/g)].map((a) => a[1]);
      const keys = new Set();
      for (const k of body.matchAll(new RegExp('\\b' + arg + '\\.payload\\.(\\w+)', 'g'))) keys.add(k[1]);
      for (const al of aliases) for (const k of body.matchAll(new RegExp('\\b' + al + '\\.(\\w+)', 'g'))) keys.add(k[1]);
      handlers.push({ ev: m[1], keys: [...keys], file: f });
    }
  }
  check('the model listens for events Rust really emits',
    handlers.every((h) => emits[h.ev]),
    handlers.filter((h) => !emits[h.ev]).map((h) => h.ev).join(','));

  /* A payload whose keys the emitter never sends. `guild_id`, `room_id` and
   * `event_id` are on almost every emit and are allowed anywhere; anything
   * else has to be a key that event really carries. */
  const everywhere = new Set(['guild_id', 'room_id', 'event_id']);
  const phantom = handlers.flatMap((h) => (h.keys || [])
    .filter((k) => !everywhere.has(k) && !opaque.has(h.ev) && emits[h.ev] && !emits[h.ev].has(k))
    .map((k) => h.ev + ' has no ' + k));
  check('…and reads only keys those events really carry',
    phantom.length === 0, [...new Set(phantom)].join(' · '));
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
