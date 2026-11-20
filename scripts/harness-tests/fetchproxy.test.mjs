// The game window's fetch → proxy_fetch wrapper (src-tauri/src/fetch_proxy.js,
// injected by main.rs with include_str!).
//
//   node scripts/harness-tests/fetchproxy.test.mjs
//
// FUNCTIONAL: the shipped file runs in a vm context whose `window` has a stub
// Tauri IPC standing in for http_proxy.rs. Pins three bugs:
//   * response bodies were text-only, so a gif fetched for its bytes came back
//     corrupted (2,308 → 4,357 bytes);
//   * `String(init.body)` sent a FormData as "[object FormData]";
//   * `new Response('', {status: 204})` throws, so a 204 POST reported failure
//     after the server had done the work.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import vm from 'node:vm';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = readFileSync(resolve(repo, 'src-tauri', 'src', 'fetch_proxy.js'), 'utf8');
const mainRs = readFileSync(resolve(repo, 'src-tauri', 'src', 'main.rs'), 'utf8');

let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? '  ok ' : 'FAIL ') + name + (ok || detail == null ? '' : ' — ' + detail));
  if (!ok) failures++;
}

/** What http_proxy::encode_body does: UTF-8 text as itself, else base64. */
function encodeBody(bytes) {
  try {
    return { body: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
  } catch (_) {
    return { body: Buffer.from(bytes).toString('base64'), encoding: 'base64' };
  }
}

/**
 * @param {(req: object) => {status: number, headers?: object, bytes?: Uint8Array}} answer
 */
function boot(answer) {
  const calls = { invoked: [], direct: [] };
  const window = {
    fetch: (input) => { calls.direct.push(typeof input === 'string' ? input : input.url); return Promise.resolve(new Response('direct')); },
    __TAURI__: {
      core: {
        invoke: (cmd, args) => {
          calls.invoked.push({ cmd, req: args.req });
          const a = answer(args.req);
          return Promise.resolve({ status: a.status, headers: a.headers || {}, ...encodeBody(a.bytes || new Uint8Array()) });
        },
      },
    },
  };
  const ctx = vm.createContext({
    window, console: { warn() {}, log() {} }, setTimeout,
    Response, Request, Headers, URL, URLSearchParams, FormData, Blob, DOMException, TextDecoder,
    btoa, atob, Uint8Array, String, Object, Array, Promise,
  });
  vm.runInContext(src, ctx);
  return { fetch: window.fetch, calls };
}

const gif = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x80, 0x00, 0xf7, 0xff, 0xfe, 0x00, 0x3b]);

console.log('main.rs injects the file');
check('  include_str!("fetch_proxy.js") is a format arg', /fetch_proxy = include_str!\("fetch_proxy\.js"\)/.test(mainRs));
check('  and the template places it', mainRs.includes('{fetch_proxy}'));
check('  the old inline copy is gone', mainRs.indexOf("invoke('proxy_fetch'") < 0);

{
  console.log('a binary response arrives byte for byte');
  const { fetch } = boot(() => ({ status: 200, headers: { 'content-type': 'image/gif' }, bytes: gif }));
  const r = await fetch('https://guild.example/img/focus/target-selected-red.gif');
  const got = new Uint8Array(await r.arrayBuffer());
  check('  same length', got.length === gif.length, got.length + ' vs ' + gif.length);
  check('  same bytes', got.every((b, i) => b === gif[i]));
  check('  headers pass through', r.headers.get('content-type') === 'image/gif');
}

{
  console.log('JSON still arrives as text');
  const json = '{"name":"Pétra ✦","n":"12"}';
  const { fetch } = boot(() => ({ status: 200, bytes: new TextEncoder().encode(json) }));
  const r = await fetch('https://guild.example/api/player/1-194');
  check('  body text is identical', (await r.text()) === json);
}

for (const status of [204, 205, 304]) {
  console.log(`a ${status} becomes a body-less Response instead of throwing`);
  const { fetch, calls } = boot(() => ({ status }));
  let r = null, err = null;
  try { r = await fetch('https://guild.example/api/auth/logout', { method: status === 304 ? 'GET' : 'POST' }); } catch (e) { err = e; }
  check('  resolves', r && r.status === status, err ? String(err) : (r && r.status));
  check('  with no body', r && r.body === null);
  check('  and is never re-sent direct', calls.direct.length === 0, calls.direct.join(','));
}

{
  console.log('a string body goes as text');
  const { fetch, calls } = boot(() => ({ status: 200 }));
  await fetch('https://guild.example/api/x', { method: 'POST', body: '{"a":1}', headers: { 'Content-Type': 'application/json' } });
  const req = calls.invoked[0].req;
  check('  body', req.body === '{"a":1}');
  check('  no body_b64', req.body_b64 == null);
  check('  headers kept', req.headers['Content-Type'] === 'application/json');
}

{
  console.log('URLSearchParams goes as form text with its content type');
  const { fetch, calls } = boot(() => ({ status: 200 }));
  await fetch('https://guild.example/api/x', { method: 'POST', body: new URLSearchParams({ a: '1 2', b: 'é' }) });
  const req = calls.invoked[0].req;
  check('  body', req.body === 'a=1+2&b=%C3%A9', req.body);
  check('  content type', /application\/x-www-form-urlencoded/.test(req.headers['content-type'] || ''));
}

{
  console.log('FormData goes as multipart bytes with its boundary');
  const { fetch, calls } = boot(() => ({ status: 200 }));
  const fd = new FormData();
  fd.append('note', 'hello');
  fd.append('file', new Blob([gif], { type: 'image/gif' }), 'a.gif');
  await fetch('https://guild.example/api/upload', { method: 'POST', body: fd });
  const req = calls.invoked[0].req;
  check('  not "[object FormData]"', req.body == null, String(req.body));
  const sent = Buffer.from(req.body_b64 || '', 'base64');
  const type = req.headers['content-type'] || '';
  check('  multipart content type with boundary', /^multipart\/form-data; boundary=/.test(type), type);
  const boundary = type.split('boundary=')[1];
  check('  body carries the boundary', boundary && sent.includes(Buffer.from(boundary)));
  check('  and the file bytes untouched', sent.includes(Buffer.from(gif)));
}

{
  console.log('an ArrayBuffer / typed array goes as bytes');
  const { fetch, calls } = boot(() => ({ status: 200 }));
  await fetch('https://guild.example/api/bin', { method: 'PUT', body: gif });
  const sent = Buffer.from(calls.invoked[0].req.body_b64 || '', 'base64');
  check('  same bytes', sent.equals(Buffer.from(gif)));
}

{
  console.log('a Request input keeps its body and headers');
  const { fetch, calls } = boot(() => ({ status: 200 }));
  await fetch(new Request('https://guild.example/api/x', { method: 'POST', body: 'payload', headers: { 'x-a': '1' } }));
  const req = calls.invoked[0].req;
  check('  method', req.method === 'POST');
  check('  header', req.headers['x-a'] === '1', JSON.stringify(req.headers));
  check('  body', Buffer.from(req.body_b64 || '', 'base64').toString() === 'payload' || req.body === 'payload');
}

{
  console.log('a GET carries no body');
  const { fetch, calls } = boot(() => ({ status: 200 }));
  await fetch('https://guild.example/api/x');
  const req = calls.invoked[0].req;
  check('  neither field set', req.body == null && req.body_b64 == null);
}

{
  console.log('relative and IPC URLs never reach the proxy');
  const { fetch, calls } = boot(() => ({ status: 200 }));
  await fetch('img/focus/x.gif');
  await fetch('http://ipc.localhost/proxy_fetch');
  check('  both went direct', calls.direct.length === 2 && calls.invoked.length === 0);
}

if (failures) {
  console.log(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nall fetch proxy checks pass');
