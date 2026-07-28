use rmcp::transport::streamable_http_server::{
    session::local::LocalSessionManager, StreamableHttpService, StreamableHttpServerConfig,
};
use std::sync::Arc;
use tokio::sync::watch;

use crate::hasher::types::TaskRegistry;
use crate::mcp::config::McpConfig;
use crate::mcp::handler::StructsMcpHandler;

pub struct McpServer {
    shutdown_tx: watch::Sender<bool>,
}

impl McpServer {
    /// Start the MCP server on the configured port with bearer token auth.
    pub async fn start(
        task_registry: Arc<TaskRegistry>,
        app_handle: tauri::AppHandle,
    ) -> Result<Self, String> {
        let mut config = McpConfig::load();
        if !config.enabled {
            return Err("MCP server is not enabled".into());
        }
        config.ensure_token();

        let port = config.port;
        let token = config
            .bearer_token
            .clone()
            .ok_or("No bearer token configured")?;

        // Web dashboard state (opt-in; routes 404 until enabled).
        crate::mcp::web_board::init_from_config();
        // Raid View is opt-in on the same terms — load its flag before any
        // route or command can be reached.
        crate::mcp::raid_view::init_from_config();
        let web_state = crate::mcp::web_board::WebState {
            app: app_handle.clone(),
            registry: task_registry.clone(),
        };

        let handler = StructsMcpHandler::new(task_registry, app_handle);

        let (shutdown_tx, shutdown_rx) = watch::channel(false);

        // Build the MCP HTTP service
        let mcp_config = StreamableHttpServerConfig::default();
        let session_manager = LocalSessionManager::default();

        let mcp_service = StreamableHttpService::new(
            move || Ok::<_, std::io::Error>(handler.clone()),
            Arc::new(session_manager),
            mcp_config,
        );

        // Bearer token auth middleware.
        // Returns 400 (not 401/403) to avoid triggering Claude Code's OAuth fallback.
        let expected_token = token.clone();
        let app = axum08::Router::new()
            .nest_service("/mcp", mcp_service)
            // Unauthenticated liveness probe: binds to 127.0.0.1 only and the
            // snapshot is deliberately shallow (no player data, no token) — so
            // launchd/cron monitors can watch the app without holding secrets.
            .route(
                "/health",
                axum08::routing::get(|| async {
                    axum08::Json(crate::mcp::watchdog::health_snapshot())
                }),
            )
            .merge(crate::mcp::web_board::router(web_state))
            .layer(axum08::middleware::from_fn(move |req: axum08::extract::Request, next: axum08::middleware::Next| {
                let expected = expected_token.clone();
                async move {
                    let path = req.uri().path();
                    if path == "/health" {
                        return Ok::<_, std::convert::Infallible>(next.run(req).await);
                    }
                    let auth_header = req.headers().get("authorization")
                        .and_then(|v| v.to_str().ok())
                        .unwrap_or("");
                    let bearer_ok = auth_header.strip_prefix("Bearer ").map(|t| t == expected).unwrap_or(false);
                    // Browser paths only: the /board pages authenticate via the
                    // session cookie (set on first visit) or a one-time ?token=
                    // query. NEVER honored for /mcp — its auth is unchanged.
                    let board_ok = path.starts_with("/board") && (
                        req.headers().get("cookie")
                            .and_then(|v| v.to_str().ok()).unwrap_or("")
                            .split(';')
                            .filter_map(|p| p.trim().split_once('='))
                            .any(|(k, v)| k == crate::mcp::web_board::BOARD_COOKIE && v == expected)
                        ||
                        req.uri().query().unwrap_or("")
                            .split('&')
                            .filter_map(|p| p.split_once('='))
                            .any(|(k, v)| k == "token" && v == expected)
                    );
                    if !(bearer_ok || board_ok) {
                        return Ok(axum08::http::Response::builder()
                            .status(400)
                            .header("content-type", "application/json")
                            .body(axum08::body::Body::from(
                                r#"{"error":"Invalid or missing bearer token. Configure Authorization header in .mcp.json"}"#
                            ))
                            .unwrap());
                    }
                    Ok::<_, std::convert::Infallible>(next.run(req).await)
                }
            }));

        let addr = format!("127.0.0.1:{}", port);
        let listener = tokio::net::TcpListener::bind(&addr)
            .await
            .map_err(|e| format!("Failed to bind to {}: {}", addr, e))?;

        eprintln!("\n╔══════════════════════════════════════════════════════════════╗");
        eprintln!("║  Structs MCP Server                                          ║");
        eprintln!("╠══════════════════════════════════════════════════════════════╣");
        eprintln!("║  URL:   http://{}/mcp", addr);
        eprintln!("║  Token: {}", token);
        eprintln!("╠══════════════════════════════════════════════════════════════╣");
        eprintln!("║  Claude Code config (~/.claude.json):                        ║");
        eprintln!("║                                                              ║");
        eprintln!("║  \"mcpServers\": {{                                            ║");
        eprintln!("║    \"structs-game\": {{                                        ║");
        eprintln!("║      \"type\": \"http\",                                        ║");
        eprintln!("║      \"url\": \"http://127.0.0.1:{}/mcp\",", port);
        eprintln!("║      \"headers\": {{                                           ║");
        eprintln!("║        \"Authorization\": \"Bearer {}\"", token);
        eprintln!("║      }}                                                       ║");
        eprintln!("║    }}                                                          ║");
        eprintln!("║  }}                                                            ║");
        eprintln!("╚══════════════════════════════════════════════════════════════╝\n");

        // Spawn the server
        let mut shutdown_rx_clone = shutdown_rx.clone();
        tokio::spawn(async move {
            axum08::serve(listener, app)
                .with_graceful_shutdown(async move {
                    let _ = shutdown_rx_clone.changed().await;
                })
                .await
                .ok();
            eprintln!("[Structs MCP] Server stopped");
        });

        Ok(Self { shutdown_tx })
    }

    pub fn stop(&self) {
        let _ = self.shutdown_tx.send(true);
    }
}
