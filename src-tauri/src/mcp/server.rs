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
            .layer(axum08::middleware::from_fn(move |req: axum08::extract::Request, next: axum08::middleware::Next| {
                let expected = expected_token.clone();
                async move {
                    let auth_header = req.headers().get("authorization")
                        .and_then(|v| v.to_str().ok())
                        .unwrap_or("");
                    let provided = auth_header.strip_prefix("Bearer ").unwrap_or("");
                    if provided != expected {
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
