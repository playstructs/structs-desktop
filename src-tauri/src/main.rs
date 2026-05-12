// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod game_state;
mod guild_config;
mod hasher;
mod http_proxy;
mod mcp;
mod menu;
mod notifications;

fn main() {
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
            mcp::event_buffer::push_game_event,
            game_state::get_sync_interval,
            game_state::notify_hash_complete,
            hasher::list_hash_tasks,
            mcp::policy::list_policies,
        ])
        .manage(std::sync::Arc::new(hasher::types::TaskRegistry::new()))
        .setup(|app| {
            use tauri::{Manager, WebviewWindowBuilder, WebviewUrl};

            // Request notification permission at startup
            notifications::request_permission();

            let config = guild_config::get_active_guild_config();
            let config_json = serde_json::to_string(&config).unwrap_or_else(|_| "null".into());

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

// Pixel art rendering for WKWebView — replace transform: scale() with zoom:
// to get nearest-neighbor scaling on text, border-images, and all assets.
// zoom: changes layout flow so we also fix width/height from 50vw→100vw etc.
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

            /* Replace per-element transform: scale() with html-level zoom.
               This preserves all internal layout relationships since the entire
               page is zoomed uniformly. The webapp's media queries still fire
               at the correct breakpoints because zoom affects CSS pixel size. */
            @media only screen and (min-width: 1152px),
            only screen and (min-height: 1024px) {{
                html {{
                    zoom: 2 !important;
                }}
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
                #notification-dialogue {{
                    transform: none !important;
                    transform-origin: unset !important;
                }}
                /* Restore dimensions to 100% since zoom is on html now */
                #menu-page-layout,
                #banner-layer,
                #hud-container,
                #loading-screen {{
                    width: 100vw !important;
                    height: 100vh !important;
                }}
                #notification-dialogue {{
                    width: 100vw !important;
                }}
                #sui-offcanvas {{
                    height: 100vh !important;
                }}
            }}

            @media only screen and (min-width: 2304px),
            only screen and (min-height: 2048px) {{
                html {{
                    zoom: 4 !important;
                }}
                #menu-page-layout,
                #banner-layer,
                #hud-container,
                #alpha-base-map-container,
                #raid-map-container,
                #preview-map-container,
                #loading-screen,
                #sui-offcanvas,
                #sui-cheatsheet-container,
                #notification-dialogue {{
                    transform: none !important;
                    transform-origin: unset !important;
                }}
                #menu-page-layout,
                #banner-layer,
                #hud-container,
                #loading-screen {{
                    width: 100vw !important;
                    height: 100vh !important;
                }}
                #notification-dialogue {{
                    width: 100vw !important;
                }}
                #sui-offcanvas {{
                    height: 100vh !important;
                }}
            }}
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
"#,
                config_json = config_json
            );

            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::default())
                .title("Structs")
                .inner_size(1280.0, 760.0)
                .min_inner_size(1024.0, 640.0)
                .initialization_script(&init_script)
                .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled)
                .build()?;

            let _ = window;

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
