// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod game_state;
mod guild_config;
mod hasher;
mod http_proxy;
mod macos_keepalive;
mod mcp;
mod menu;
mod notifications;

fn main() {
    // Windows WebView2 (Chromium) can crash the renderer with an "Out of Memory"
    // error page at launch when its GPU process / driver over-allocates. Disabling
    // the WebView's GPU compositor forces UI painting onto the CPU (cheap at the
    // app's 1280x760 window) and sidesteps that path. This is a Chromium flag
    // scoped to the WebView2 renderer only — it does NOT touch the native wgpu
    // GPU hasher (src-tauri/src/hasher/gpu.rs), so GPU hashing is unaffected.
    // Must be set before WebView2 initializes. macOS/Linux are unaffected.
    #[cfg(target_os = "windows")]
    std::env::set_var(
        "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
        "--disable-gpu --disable-gpu-compositing",
    );

    tauri::Builder::default()
        .menu(menu::build)
        .invoke_handler(tauri::generate_handler![
            guild_config::get_active_guild_config,
            guild_config::get_guild_configs,
            guild_config::set_guild_config,
            guild_config::set_active_guild,
            guild_config::delete_guild_config,
            http_proxy::proxy_fetch,
            notifications::send_notification,
            hasher::start_hash_task,
            hasher::stop_hash_task,
            hasher::get_hash_task_progress,
            game_state::sync_game_state,
            mcp::config::get_mcp_config,
            mcp::config::set_mcp_enabled,
            mcp::config::get_mcp_token,
            mcp::config::set_mcp_port,
            mcp::tx_queue::mcp_transaction_response,
            mcp::ui_bridge::mcp_ui_response,
            mcp::event_buffer::push_game_event,
            game_state::get_sync_interval,
            game_state::notify_hash_complete,
            game_state::conn_log,
            hasher::list_hash_tasks,
            mcp::policy::list_policies,
        ])
        .manage(std::sync::Arc::new(hasher::types::TaskRegistry::new()))
        .setup(|app| {
            use tauri::{Manager, WebviewWindowBuilder, WebviewUrl};

            // Request notification permission at startup
            notifications::request_permission();

            // Hold an NSProcessInfo activity for the lifetime of the app to
            // prevent macOS App Nap from suspending the process when the
            // window backgrounds. Stored in app state so it's dropped on quit.
            // No-op on non-macOS platforms.
            app.manage(macos_keepalive::begin_keepalive(
                "Structs live game state sync",
            ));

            let config = guild_config::get_active_guild_config();
            let config_json = serde_json::to_string(&config).unwrap_or_else(|_| "null".into());

            // macOS WKWebView pixel-art workarounds. These are HARMFUL on Windows/Linux,
            // where the WebView is Chromium (WebView2): `html { zoom }` makes the compositor
            // re-rasterize full-screen layers at 2x/4x, exhausting the renderer's memory budget
            // ("Out of Memory" crash at launch on high-res displays). Chromium gets crisp
            // pixel-art from the global `image-rendering: pixelated` rules + the webapp's own
            // `transform: scale()` path (structs-webapp main.css), so on non-macOS we omit
            // these and fall back to the webapp's native, browser-tested rendering.
            let macos_zoom_css = if cfg!(target_os = "macos") {
                r#"
            /* Replace per-element transform: scale() with html-level zoom.
               This preserves all internal layout relationships since the entire
               page is zoomed uniformly. The webapp's media queries still fire
               at the correct breakpoints because zoom affects CSS pixel size. */
            @media only screen and (min-width: 1152px),
            only screen and (min-height: 1024px) {
                html {
                    zoom: 2 !important;
                }
                /* Remove the per-element transforms since html zoom handles it */
                #menu-page-layout,
                #banner-layer,
                #hud-container,
                #alpha-base-map-container,
                #raid-map-container,
                #preview-map-container,
                #loading-screen,
                #sui-offcanvas,
                #sui-cheatsheet-container,
                #notification-dialogue,
                .map-pip {
                    transform: none !important;
                    transform-origin: unset !important;
                }
                /* Restore dimensions to 100% since zoom is on html now */
                #menu-page-layout,
                #banner-layer,
                #hud-container,
                #loading-screen {
                    width: 100vw !important;
                    height: 100vh !important;
                }
                #notification-dialogue {
                    width: 100vw !important;
                }
                #sui-offcanvas {
                    height: 100vh !important;
                }
            }

            @media only screen and (min-width: 2304px),
            only screen and (min-height: 2048px) {
                html {
                    zoom: 4 !important;
                }
                #menu-page-layout,
                #banner-layer,
                #hud-container,
                #alpha-base-map-container,
                #raid-map-container,
                #preview-map-container,
                #loading-screen,
                #sui-offcanvas,
                #sui-cheatsheet-container,
                #notification-dialogue,
                .map-pip {
                    transform: none !important;
                    transform-origin: unset !important;
                }
                #menu-page-layout,
                #banner-layer,
                #hud-container,
                #loading-screen {
                    width: 100vw !important;
                    height: 100vh !important;
                }
                #notification-dialogue {
                    width: 100vw !important;
                }
                #sui-offcanvas {
                    height: 100vh !important;
                }
            }
"#
            } else {
                ""
            };

            // macOS WKWebView forces all Lottie animations to the canvas renderer for crisp
            // pixel-art. On Chromium (Windows/Linux) this creates a per-animation canvas
            // backing store for every animation — a second memory multiplier — and is
            // unnecessary: the webapp's native `renderer: 'svg'` Lottie + the SVG
            // `image-rendering: pixelated` observer already render crisply and cheaply.
            let macos_lottie_canvas = if cfg!(target_os = "macos") {
                r#"
// Lottie renderer override — every animation in this app is pixel-art, so
// force the canvas renderer (with imageSmoothingEnabled=false applied via
// the global setter wrapper above). Catches every loadAnimation call site,
// existing or future, without per-file build patches.
(function() {
    function tryPatch() {
        var lib = window.lottie || window.bodymovin;
        if (!lib || typeof lib.loadAnimation !== 'function' || lib.loadAnimation.__structsPatched) {
            if (!lib || typeof lib.loadAnimation !== 'function') return setTimeout(tryPatch, 100);
            return;
        }
        var original = lib.loadAnimation.bind(lib);
        var wrapped = function(params) {
            try {
                var p = Object.assign({}, params || {});
                if (!p.renderer || p.renderer === 'svg') p.renderer = 'canvas';
                if (p.renderer === 'canvas') {
                    p.rendererSettings = Object.assign(
                        { clearCanvas: true, preserveAspectRatio: 'xMidYMid meet' },
                        p.rendererSettings || {}
                    );
                }
                var anim = original(p);
                // Belt-and-suspenders: when Lottie's canvas exists, lock
                // imageSmoothingEnabled=false on the 2D context. The global
                // wrapper handles future writes; this covers any initial
                // value Lottie may have set in its own context creation.
                var disable = function() {
                    try {
                        var container = (typeof p.container === 'string')
                            ? document.querySelector(p.container)
                            : p.container;
                        var c = container && container.querySelector ? container.querySelector('canvas') : null;
                        if (c) {
                            var ctx = c.getContext('2d');
                            if (ctx) ctx.imageSmoothingEnabled = false;
                        }
                    } catch (e) { /* ignore */ }
                };
                if (anim && typeof anim.addEventListener === 'function') {
                    anim.addEventListener('DOMLoaded', disable);
                }
                setTimeout(disable, 0);
                return anim;
            } catch (e) {
                console.warn('[Structs Lottie] interceptor error, falling back:', e);
                return original(params);
            }
        };
        wrapped.__structsPatched = true;
        lib.loadAnimation = wrapped;
    }
    tryPatch();
})();
"#
            } else {
                ""
            };

            let init_script = format!(
                r#"
window.__STRUCTS_CONFIG__ = {config_json};

// Disable canvas image smoothing globally for pixel-perfect Lottie rendering.
// Wrap the native setter so any write — including Lottie's per-frame reset — always lands as false
// on WebKit's internal slot. A no-op setter would just make reads lie while leaving smoothing on.
(function() {{
    function lockOff(proto, name) {{
        var orig = Object.getOwnPropertyDescriptor(proto, name);
        if (!orig || !orig.set) return;
        Object.defineProperty(proto, name, {{
            get: function() {{ return false; }},
            set: function() {{ orig.set.call(this, false); }},
            configurable: true
        }});
    }}
    var proto = CanvasRenderingContext2D.prototype;
    lockOff(proto, 'imageSmoothingEnabled');
    lockOff(proto, 'webkitImageSmoothingEnabled');
}})();

// SVG image-rendering fix for Lottie animations (defeat/victory banners)
// Sets image-rendering="pixelated" on all SVG <image> elements as they're created
(function() {{
    var observer = new MutationObserver(function(mutations) {{
        mutations.forEach(function(m) {{
            m.addedNodes.forEach(function(node) {{
                if (node.querySelectorAll) {{
                    node.querySelectorAll('image').forEach(function(img) {{
                        img.setAttribute('image-rendering', 'pixelated');
                    }});
                }}
                if (node.tagName === 'image') {{
                    node.setAttribute('image-rendering', 'pixelated');
                }}
            }});
        }});
    }});
    if (document.body) {{
        observer.observe(document.body, {{ childList: true, subtree: true }});
    }} else {{
        document.addEventListener('DOMContentLoaded', function() {{
            observer.observe(document.body, {{ childList: true, subtree: true }});
            document.querySelectorAll('svg image').forEach(function(img) {{
                img.setAttribute('image-rendering', 'pixelated');
            }});
        }});
    }}
}})();

// Pixel art rendering. The global image-rendering rules below apply on every
// platform. On macOS WKWebView only, the cfg-gated CSS injected here also swaps
// the webapp's transform: scale() for html-level zoom (see main.rs); on
// Chromium/WebView2 we keep the webapp's native transform path to avoid OOM.
(function() {{
    function injectPixelStyle() {{
        var style = document.createElement('style');
        style.textContent = `
            *, *::before, *::after {{
                image-rendering: pixelated !important;
                image-rendering: -webkit-optimize-contrast !important;
                -webkit-font-smoothing: none !important;
                -moz-osx-font-smoothing: unset !important;
            }}
            canvas {{
                image-rendering: pixelated !important;
                image-rendering: -webkit-optimize-contrast !important;
                image-rendering: crisp-edges !important;
            }}
            svg, svg image, svg *, .raid-end-banner svg, .raid-end-banner svg image {{
                image-rendering: pixelated !important;
                image-rendering: -webkit-optimize-contrast !important;
            }}
{macos_zoom_css}
        `;
        document.head.appendChild(style);
    }}
    if (document.head) {{
        injectPixelStyle();
    }} else {{
        document.addEventListener('DOMContentLoaded', injectPixelStyle);
    }}
}})();

// Proxy HTTP fetch through Tauri to bypass CORS and ATS
(function() {{
    const originalFetch = window.fetch;
    window.fetch = async function(input, init) {{
        const url = (typeof input === 'string') ? input : input.url;

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
            || url.startsWith('tauri://')) {{
            return originalFetch.call(this, input, init);
        }}

        // Only proxy absolute HTTP URLs (not relative, not ws://, not blob:, etc.)
        if (url.startsWith('http://') || url.startsWith('https://')) {{
            try {{
                const method = (init && init.method) || 'GET';
                const headers = {{}};
                if (init && init.headers) {{
                    const h = (init.headers instanceof Headers) ? Object.fromEntries(init.headers) : init.headers;
                    Object.assign(headers, h);
                }}
                const body = (init && init.body) ? String(init.body) : null;

                // Wait for Tauri IPC to be ready (handles init script timing)
                let tauri = window.__TAURI__;
                if (!tauri || !tauri.core) {{
                    // IPC not ready yet — wait briefly and retry
                    await new Promise(r => setTimeout(r, 100));
                    tauri = window.__TAURI__;
                }}
                if (!tauri || !tauri.core) {{
                    console.warn('[Structs Proxy] Tauri IPC not available, falling back to direct fetch:', url);
                    return originalFetch.call(this, input, init);
                }}

                const result = await tauri.core.invoke('proxy_fetch', {{
                    req: {{ url, method, headers, body }}
                }});

                return new Response(result.body, {{
                    status: result.status,
                    headers: result.headers,
                }});
            }} catch (e) {{
                console.warn('[Structs Proxy] Proxy failed, falling back to direct fetch:', url, e);
                return originalFetch.call(this, input, init);
            }}
        }}

        // Pass through for relative URLs, blobs, etc.
        return originalFetch.call(this, input, init);
    }};
}})();

// Rust-driven sync tick — see main.rs setup hook. WKWebView can throttle
// setTimeout under occlusion even with App Nap suppressed, so we also let
// Rust trigger sync. The JS handler just re-dispatches as a CustomEvent so
// structs-config.js can subscribe without holding a Tauri import.
(function() {{
    function attach() {{
        if (!window.__TAURI__ || !window.__TAURI__.event) {{
            return setTimeout(attach, 100);
        }}
        window.__TAURI__.event.listen('structs://sync-tick', function() {{
            window.dispatchEvent(new CustomEvent('structs:sync-tick'));
        }});
    }}
    attach();
}})();

// Visibility-change bridge — when the window comes back to the foreground,
// fire a custom event the GrassManager patch listens for to verify its
// NATS subscription is still alive (Layer 3 reconnect).
(function() {{
    document.addEventListener('visibilitychange', function() {{
        if (document.visibilityState === 'visible') {{
            window.dispatchEvent(new CustomEvent('structs:grass-resume-check'));
            // Also kick the sync — first-message-on-resume should be fresh.
            window.dispatchEvent(new CustomEvent('structs:sync-tick'));
        }}
    }});
}})();

{macos_lottie_canvas}
"#,
                config_json = config_json,
                macos_zoom_css = macos_zoom_css,
                macos_lottie_canvas = macos_lottie_canvas,
            );

            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::default())
                .title("Structs")
                .inner_size(1280.0, 760.0)
                .min_inner_size(1024.0, 640.0)
                .initialization_script(&init_script)
                .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled)
                .build()?;

            // Disable WKWebView hidden-page DOM-timer throttling so the grass/NATS
            // heartbeat and JS listeners keep ticking at full rate while the window
            // is occluded/minimized. `background_throttling: Disabled` above only
            // covers the inactive-but-visible path; this covers visibilityState=hidden.
            #[cfg(target_os = "macos")]
            {
                let _ = window.with_webview(|platform_webview| unsafe {
                    macos_keepalive::disable_hidden_page_throttling(platform_webview.inner());
                });
            }

            let _ = window;

            // Rust-driven sync tick. The JS-side setTimeout loop can stall
            // under WKWebView occlusion even with App Nap suppressed, so we
            // also emit a tick from Rust at the same cadence. The frontend's
            // syncGameState is debounced, so a double-fire is harmless.
            {
                let app_handle_tick = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    use tauri::Emitter;
                    loop {
                        let interval_ms = game_state::current_sync_interval_ms();
                        tokio::time::sleep(std::time::Duration::from_millis(interval_ms)).await;
                        let _ = app_handle_tick.emit("structs://sync-tick", ());
                    }
                });
            }

            // Start MCP server (auto-enable on first run)
            let mut mcp_config = mcp::config::McpConfig::load();
            if !mcp_config.enabled {
                mcp_config.enabled = true;
                mcp_config.ensure_token();
                let _ = mcp_config.save();
            }
            let mcp_port = mcp_config.port;
            let mcp_token = mcp_config.bearer_token.clone().unwrap_or_default();
            {
                let registry = app.handle().state::<std::sync::Arc<hasher::types::TaskRegistry>>().inner().clone();
                let app_handle_mcp = app.handle().clone();
                std::thread::spawn(move || {
                    let rt = tokio::runtime::Runtime::new().unwrap();
                    rt.block_on(async {
                        match mcp::server::McpServer::start(registry, app_handle_mcp).await {
                            Ok(_server) => {
                                eprintln!("[Structs MCP] Server started successfully");
                                loop {
                                    tokio::time::sleep(std::time::Duration::from_secs(3600)).await;
                                }
                            }
                            Err(e) => {
                                eprintln!("[Structs MCP] Failed to start: {}", e);
                            }
                        }
                    });
                });
            }

            // Print MCP connection info to the JS console after page loads
            let mcp_js = format!(
                r#"
                setTimeout(function() {{
                    console.log('%c Structs MCP Server ', 'background: #43CDB6; color: #133546; font-weight: bold; padding: 4px 8px;');
                    console.log('URL:   http://127.0.0.1:{port}/mcp');
                    console.log('Token: {token}');
                    console.log('');
                    console.log('Claude Code config (~/.claude.json):');
                    console.log(JSON.stringify({{
                        mcpServers: {{
                            "structs-game": {{
                                type: "http",
                                url: "http://127.0.0.1:{port}/mcp",
                                headers: {{
                                    Authorization: "Bearer {token}"
                                }}
                            }}
                        }}
                    }}, null, 2));
                }}, 2000);
                "#,
                port = mcp_port,
                token = mcp_token,
            );
            window.eval(&mcp_js).ok();

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running structs app");
}
