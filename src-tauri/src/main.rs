// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod game_state;
mod guild_config;
mod guild_directory;
mod hasher;
mod http_proxy;
mod macos_keepalive;
mod matrix;
mod mcp;
mod menu;
mod notifications;
mod remote_image;
mod updater;

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
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        // Remember every window's position/size/maximized state across
        // launches, keyed by window label — the game view, Team Ops, the
        // Stream pop-out, and each raid-<location> window all come back where
        // the player parked them. SIZE/POSITION/MAXIMIZED only: restoring
        // VISIBLE would fight the board's own reopen-on-boot flag, and
        // FULLSCREEN restores have known quirks on macOS spaces.
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::SIZE
                        | tauri_plugin_window_state::StateFlags::POSITION
                        | tauri_plugin_window_state::StateFlags::MAXIMIZED,
                )
                .build(),
        )
        .menu(menu::build)
        .invoke_handler(tauri::generate_handler![
            guild_config::get_active_guild_config,
            guild_config::get_guild_configs,
            guild_config::set_guild_config,
            guild_config::set_active_guild,
            guild_config::delete_guild_config,
            guild_directory::refresh_guild_directory,
            guild_directory::apply_guild_switch,
            http_proxy::proxy_fetch,
            notifications::send_notification,
            mcp::log_bundle::export_log_bundle,
            mcp::log_bundle::log_ui_events,
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
            mcp::vplayer_bridge::vplayer_response,
            mcp::native_signer::native_signer_import,
            mcp::native_signer::native_signer_status,
            mcp::native_signer::native_signer_forget,
            mcp::event_buffer::push_game_event,
            mcp::event_buffer::mcp_grass_recent,
            mcp::txq_bridge::txq_response,
            mcp::tools::board::mcp_board_html,
            mcp::tools::board::mcp_board_refresh,
            mcp::tools::board::mcp_vplayer_list,
            mcp::tools::board_pages::mcp_roster,
            mcp::tools::board_pages::mcp_roster_refresh,
            mcp::tools::board_pages::mcp_player_detail,
            mcp::tools::board_pages::mcp_energy,
            mcp::tools::board_pages::mcp_work,
            mcp::board_feed::open_stream_window,
            mcp::board_feed::open_board_window,
            mcp::game_stats::open_game_stats_window,
            // Comms (federated Matrix chat). Reachable only from the Debug
            // panel for now — see src/matrix/mod.rs.
            matrix::open_chat_window,
            matrix::close_chat_window,
            matrix::matrix_status,
            matrix::matrix_select,
            matrix::matrix_connect,
            matrix::matrix_disconnect,
            matrix::matrix_rooms,
            matrix::matrix_browse,
            matrix::matrix_timeline,
            matrix::matrix_backfill,
            matrix::matrix_open_url,
            matrix::matrix_media,
            remote_image::remote_image,
            mcp::tools::board_pages::mcp_player_profile,
            mcp::tools::board_pages::mcp_player_search,
            matrix::matrix_members,
            matrix::matrix_mark_read,
            matrix::matrix_send,
            matrix::matrix_join,
            matrix::matrix_leave,
            matrix::matrix_dm,
            matrix::matrix_people,
            matrix::matrix_typing,
            matrix::matrix_badge,
            matrix::matrix_unread,
            matrix::matrix_presence,
            matrix::matrix_object_chatter,
            matrix::matrix_status_sharing,
            matrix::matrix_search,
            matrix::matrix_react,
            matrix::matrix_id_suggestions,
            matrix::matrix_redact,
            matrix::matrix_edit,
            matrix::matrix_work_offer,
            matrix::matrix_work_verify,
            matrix::matrix_work_accept,
            matrix::matrix_work_params,
            matrix::matrix_work_status,
            matrix::matrix_mute,
            matrix::matrix_work_submit,
            matrix::matrix_pinned,
            matrix::matrix_pin,
            matrix::matrix_refs,
            matrix::matrix_agreement_open,
            matrix::matrix_message_player,
            matrix::matrix_take_pending_room,
            matrix::matrix_share,
            matrix::matrix_take_pending_draft,
            matrix::matrix_open_as,
            matrix::matrix_object_room,
            matrix::matrix_object_room_create,
            matrix::matrix_open_transfer,
            matrix::matrix_take_pending_transfer,
            mcp::game_stats::mcp_game_stats_snapshot,
            mcp::tools::board_pages::mcp_health,
            mcp::tools::board_pages::mcp_allocations,
            mcp::tools::board_pages::mcp_allocation_preview,
            mcp::tools::board_pages::mcp_allocation_set_power,
            mcp::tools::board_pages::mcp_allocation_connect,
            mcp::tools::board_pages::mcp_allocation_create,
            mcp::tools::infusions::mcp_infusions,
            mcp::tools::infusions::mcp_infusion_preview,
            mcp::tools::infusions::mcp_infusion_infuse,
            mcp::tools::infusions::mcp_infusion_defuse,
            mcp::tools::infusions::mcp_infusion_migrate,
            mcp::tools::infusions::mcp_infusion_cancel_defusion,
            mcp::tools::infusions::mcp_infusion_restart,
            mcp::tools::board_pages::mcp_inventory,
            mcp::tools::board_pages::mcp_inventory_history,
            mcp::tools::board_pages::mcp_transfer_preview,
            mcp::tools::board_pages::mcp_transfer_execute,
            mcp::tools::board_pages::mcp_war_bundle,
            mcp::tools::board_pages::mcp_config_bundle,
            mcp::raid_view::mcp_raids,
            mcp::raid_view::mcp_raid_view_open,
            mcp::raid_view::mcp_raid_state,
            mcp::raid_view::mcp_raid_log,
            mcp::tools::board_pages::mcp_config_set,
            mcp::tools::board_pages::mcp_callsign_get,
            mcp::tools::board_pages::mcp_profiles_get,
            mcp::tools::board_pages::mcp_callsign_set,
            mcp::tools::board_pages::mcp_role_pfp_get,
            mcp::tools::board_pages::mcp_role_pfp_set,
            mcp::tools::board_pages::mcp_tx_snapshot,
            mcp::tools::board_pages::mcp_tx_mutate,
            mcp::tools::mass_action::mcp_mass_action,
            mcp::tools::map::mcp_render_map,
            mcp::board_feed::mcp_board_feed,
            game_state::get_sync_interval,
            game_state::notify_hash_complete,
            game_state::conn_log,
            hasher::list_hash_tasks,
            mcp::policy::list_policies,
            updater::check_for_update,
            updater::open_url,
            updater::updater_supported,
            updater::download_and_install_update,
            updater::relaunch_app,
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

            // RETIRED: the macOS `html { zoom: 2/4 }` injection that replaced the
            // webapp's per-element `transform: scale()`. Its correctness depended on
            // LEGACY WebKit zoom semantics, where viewport units (100vw/100vh) were
            // divided by the root zoom so full-screen layers still fit. Safari 17.4
            // standardized CSS zoom and viewport units are no longer divided — on any
            // recent macOS the injected `width: 100vw` layers painted at 2x/4x the
            // window, anchored top-left, cropping the ENTIRE app (loading screen
            // included) to its top-left quarter. Verified against a user's 3440x1440
            // screen recording and reproduced pixel-for-pixel in a viewport fixture;
            // the webapp's own transform+50vw path renders correctly at 1512/2560/
            // 3440 wide under both semantics, so macOS now simply uses it, like every
            // browser player does.

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

// Guild-switch handoff: the config above is frozen at app start, but a live
// guild switch (guild_directory::apply_guild_switch) stores the new config in
// sessionStorage and reloads. sessionStorage reads are synchronous at
// document-start, so the override wins before any webapp JS parses. Cleared
// on app exit; the next cold start bakes the already-updated persisted config.
try {{
    var __cfgOverride = sessionStorage.getItem('structs_config_override');
    if (__cfgOverride) window.__STRUCTS_CONFIG__ = JSON.parse(__cfgOverride);
}} catch (e) {{}}

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

// Re-disable smoothing after every canvas resize. Setting canvas.width/height
// RESETS the 2D context to defaults (imageSmoothingEnabled=true), so the
// one-time disable at animation load does NOT survive Lottie resizing its
// canvas — which is what leaves idle struct loops, the onboarding portrait,
// and other animations blurry after they're shown/resized. Track which
// canvases are 2D (via getContext) and re-apply smoothing=false on each
// width/height write, before the next draw. Global, so it covers every
// current and future animation without per-site patches.
(function() {{
    if (!window.HTMLCanvasElement || !HTMLCanvasElement.prototype) return;
    var TWO_D = new WeakSet();
    var origGet = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function(type) {{
        var ctx = origGet.apply(this, arguments);
        if (ctx && type === '2d') {{
            TWO_D.add(this);
            try {{ ctx.imageSmoothingEnabled = false; }} catch (e) {{}}
        }}
        return ctx;
    }};
    ['width', 'height'].forEach(function(prop) {{
        var d = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, prop);
        if (!d || !d.set) return;
        Object.defineProperty(HTMLCanvasElement.prototype, prop, {{
            get: d.get,
            set: function(v) {{
                d.set.call(this, v);
                // Only for known-2D canvases, so we never force a 2D context
                // onto a WebGL/other canvas.
                if (TWO_D.has(this)) {{
                    try {{ var c = origGet.call(this, '2d'); if (c) c.imageSmoothingEnabled = false; }} catch (e) {{}}
                }}
            }},
            configurable: true
        }});
    }});
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

            // Reopen the Team Ops (dashboard) window if it was open at last exit.
            // The reopen flag is only ever set after the player intentionally
            // opened the board via MCP, so this never opens for a player who
            // hasn't — it only restores a board they chose to have open.
            mcp::board_feed::reopen_if_persisted(app.handle());

            // On-chain guild directory refresh (non-blocking; persisted config
            // is authoritative at boot). Keeps guild infra URLs fresh and
            // re-applies the active config if its URLs changed on-chain.
            guild_directory::startup_refresh(app.handle().clone());

            // Resume chat sync for guilds already signed in. A player who has
            // never opened Comms has no stored session, so this is a no-op and
            // the feature stays entirely dormant for them.
            matrix::boot(app.handle().clone());

            // Rust-side update check — webview-independent, so a build that
            // breaks its own frontend can still download + stage its replacement
            // and notify the user natively. Applies on next restart (never
            // interrupts a live session).
            updater::check_and_stage_on_startup(app.handle().clone());

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
                        // Watchdog lives on THIS timer (not the sync tick) so a
                        // dead webview/sync pipeline is still detected. Cheap:
                        // self-throttles to one detection pass per minute.
                        // catch_unwind: this task is the resilience backstop —
                        // a panic in a detection or remedy must not kill the
                        // sync-tick fallback AND the watchdog in one stroke.
                        let check = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                            mcp::watchdog::check(&app_handle_tick);
                        }));
                        if check.is_err() {
                            mcp::telemetry::tlog(
                                "watchdog",
                                mcp::telemetry::Sev::Error,
                                "watchdog check panicked — resilience loop continuing",
                            );
                        }
                    }
                });
            }

            // Restore persisted PoW knobs (they were memory-only atomics that
            // reset on every restart before hash_config.json existed).
            hasher::load_persisted_config();

            // Start MCP server (auto-enable on first run)
            let mut mcp_config = mcp::config::McpConfig::load();
            if !mcp_config.enabled {
                mcp_config.enabled = true;
                mcp_config.ensure_token();
                let _ = mcp_config.save();
            }
            let mcp_port = mcp_config.port;
            let mcp_token = mcp_config.bearer_token.clone().unwrap_or_default();
            // Signing-throughput knobs (persisted in mcp_config.json, live-
            // settable via `structs_system config`).
            mcp::vplayer_bridge::set_sign_mode(&mcp_config.sign_mode);
            mcp::verify::set_source(&mcp_config.verify_source);
            mcp::perception::set_snapshot_source(&mcp_config.snapshot_source);
            // Native signer: load the key from the OS keychain (off-thread);
            // until the game hands one over, native modes fall back to the webview.
            mcp::native_signer::init();
            if let Some(cap) = mcp_config.tx_gate_cap {
                mcp::tx_gate::set_cap(cap);
            }
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
        .build(tauri::generate_context!())
        .expect("error while building structs app")
        .run(|_app_handle, event| {
            // Mark shutdown BEFORE windows are torn down, so the board window's
            // close handler treats app-exit teardown as "leave the reopen flag
            // set" (it was open at quit) rather than a user dismiss.
            if let tauri::RunEvent::ExitRequested { .. } = event {
                mcp::board_feed::mark_app_quitting();
            }
        });
}
