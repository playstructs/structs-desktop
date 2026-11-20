// Proxy HTTP fetch through Tauri to bypass CORS and ATS.
//
// Injected into the game window by main.rs (include_str!), so it is plain JS:
// no Rust format! escaping. Tested in scripts/harness-tests/fetchproxy.test.mjs.
(function() {
    const originalFetch = window.fetch;

    // Statuses whose Response may not have a body. `new Response('', {status:
    // 204})` THROWS, and the proxy always has a body (an empty string at
    // least), so before this a 204 POST reported failure after the server had
    // done the work, and a 304 GET silently went out a second time direct.
    const NULL_BODY = { 204: 1, 205: 1, 304: 1 };

    function toBase64(buf) {
        const bytes = new Uint8Array(buf);
        let bin = '';
        for (let i = 0; i < bytes.length; i += 0x8000) {
            bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        }
        return btoa(bin);
    }

    function fromBase64(b64) {
        const bin = atob(b64);
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
    }

    // The request body as it crosses IPC: text stays text; anything else
    // (FormData, Blob, ArrayBuffer, a typed array, a Request's own body) is
    // serialised the way the browser itself would — `new Request` picks the
    // bytes and, for FormData, the multipart boundary in its content-type.
    // `String(body)` sent a FormData as "[object FormData]".
    async function encodeBody(input, init, url, method, headers) {
        const raw = init && init.body != null ? init.body : null;
        if (typeof raw === 'string') return { body: raw };
        if (raw instanceof URLSearchParams) {
            if (!hasHeader(headers, 'content-type')) {
                headers['content-type'] = 'application/x-www-form-urlencoded;charset=UTF-8';
            }
            return { body: raw.toString() };
        }
        let req = null;
        if (raw != null) {
            req = new Request(url, { method, body: raw });
        } else if (input instanceof Request && input.body != null && method !== 'GET' && method !== 'HEAD') {
            req = input.clone();
        }
        if (!req) return {};
        const type = req.headers.get('content-type');
        if (type && !hasHeader(headers, 'content-type')) headers['content-type'] = type;
        return { body_b64: toBase64(await req.arrayBuffer()) };
    }

    function hasHeader(headers, name) {
        return Object.keys(headers).some(function (k) { return k.toLowerCase() === name; });
    }

    function toResponse(result) {
        const body = NULL_BODY[result.status] ? null
            : result.encoding === 'base64' ? fromBase64(result.body)
            : result.body;
        return new Response(body, { status: result.status, headers: result.headers });
    }

    window.fetch = async function(input, init) {
        const url = (typeof input === 'string') ? input
            : (input instanceof URL) ? input.href
            : input.url;

        // Skip Tauri's own IPC transport. On Windows WebView2, Tauri 2 implements
        // tauri.core.invoke() on top of `fetch('http://ipc.localhost/...')`. If we
        // route that through our proxy, calling invoke('proxy_fetch') triggers a
        // fetch to http://ipc.localhost/proxy_fetch — which our proxy re-catches,
        // calls invoke('proxy_fetch') again with the previous IPC body embedded in
        // the new one, and the payload doubles per recursion until JSON.stringify
        // throws "Invalid string length" (V8's ~512 MB string cap). The renderer
        // burns several hundred MB on the way there → "Out of Memory" crash page.
        // macOS WKWebView uses a different IPC transport so the bug is invisible
        // there. Filter these URLs before the proxy fast-path.
        if (url.startsWith('http://ipc.localhost')
            || url.startsWith('https://ipc.localhost')
            || url.startsWith('ipc://')
            || url.startsWith('tauri://')) {
            return originalFetch.call(this, input, init);
        }

        // Only proxy absolute HTTP URLs (not relative, not ws://, not blob:, etc.)
        if (url.startsWith('http://') || url.startsWith('https://')) {
            const method = ((init && init.method) || (input instanceof Request && input.method) || 'GET').toUpperCase();
            const signal = (init && init.signal) || (input instanceof Request ? input.signal : null);
            const aborted = () => new DOMException('The operation was aborted.', 'AbortError');
            // A direct fetch after a proxy failure is a SECOND request. Only
            // idempotent methods may take it: a POST (the v0.22 logout, a
            // signup) that the proxy already sent must never go out twice.
            const idempotent = method === 'GET' || method === 'HEAD' || method === 'OPTIONS';
            if (signal && signal.aborted) throw aborted();
            try {
                const headers = {};
                if (input instanceof Request) {
                    input.headers.forEach(function (v, k) { headers[k] = v; });
                }
                if (init && init.headers) {
                    const h = (init.headers instanceof Headers || Array.isArray(init.headers)) ? Object.fromEntries(init.headers) : init.headers;
                    Object.assign(headers, h);
                }
                const encoded = await encodeBody(input, init, url, method, headers);

                // Wait for Tauri IPC to be ready (handles init script timing)
                let tauri = window.__TAURI__;
                if (!tauri || !tauri.core) {
                    // IPC not ready yet — wait briefly and retry
                    await new Promise(r => setTimeout(r, 100));
                    tauri = window.__TAURI__;
                }
                if (!tauri || !tauri.core) {
                    console.warn('[Structs Proxy] Tauri IPC not available, falling back to direct fetch:', url);
                    return originalFetch.call(this, input, init);
                }

                const call = tauri.core.invoke('proxy_fetch', {
                    req: {
                        url, method, headers,
                        body: encoded.body != null ? encoded.body : null,
                        body_b64: encoded.body_b64 != null ? encoded.body_b64 : null,
                    }
                });
                // Honour the caller's AbortSignal (the v0.22 webapp aborts page
                // work on navigation and bounds every request with one). The
                // proxied request may still complete in Rust; its answer is
                // simply not delivered, exactly like an aborted fetch.
                const result = signal
                    ? await Promise.race([call, new Promise((_, rej) =>
                        signal.addEventListener('abort', () => rej(aborted()), { once: true }))])
                    : await call;

                return toResponse(result);
            } catch (e) {
                if ((e && e.name === 'AbortError') || (signal && signal.aborted)) throw aborted();
                if (!idempotent) {
                    console.warn('[Structs Proxy] Proxy failed; not re-sending a ' + method + ':', url, e);
                    throw new TypeError('Failed to fetch: ' + String((e && e.message) || e));
                }
                console.warn('[Structs Proxy] Proxy failed, falling back to direct fetch:', url, e);
                return originalFetch.call(this, input, init);
            }
        }

        // Pass through for relative URLs, blobs, etc.
        return originalFetch.call(this, input, init);
    };
})();
