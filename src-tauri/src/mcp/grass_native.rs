//! Native GRASS: the NATS stream subscribed from Rust.
//!
//! Until 2026-09-04 every GRASS frame reached the app through the GAME
//! webview: a `WebSocket` proxy in structs-config.js sniffed the webapp's own
//! NATS socket and forwarded each payload with `invoke('push_game_event')`.
//! Measured that day: production NATS delivers 100% to a raw client on the
//! same machine, Rust stores every event it is handed, and ~20% of frames
//! still never arrived — lost somewhere between the webview listener and the
//! IPC. The snapshot then believed built structs were still building (double
//! completions, "already has a struct on that slot", defense clears on links
//! the chain had dropped).
//!
//! This module takes the webview out of the delivery path: the official
//! `async-nats` client, over its WebSocket transport, subscribed to the two
//! subjects the webapp subscribes (`structs.>` for every planet / grid /
//! player frame, `consensus` for the block heartbeat), handing every payload
//! to the same [`event_buffer::ingest`] the webview path uses. The webview
//! tap stays as the fallback: while this subscriber is live its duplicates
//! are dropped at `push_game_event`; when it is not (knob
//! `grass_source: webview`, or an outage), the tap carries the stream as
//! before.

use futures_util::StreamExt;
use serde_json::{json, Map, Value};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use crate::mcp::event_buffer::GameEvent;
use crate::mcp::telemetry::{tlog, Sev};

// ── knob ────────────────────────────────────────────────────────────────

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum GrassSource {
    /// Subscribe from Rust (default). The webview tap is a fallback only.
    Native,
    /// Do not connect from Rust; the webview tap carries the stream.
    Webview,
}

impl GrassSource {
    pub fn name(self) -> &'static str {
        match self {
            GrassSource::Native => "native",
            GrassSource::Webview => "webview",
        }
    }
    fn parse(s: &str) -> Option<Self> {
        match s.trim().to_ascii_lowercase().as_str() {
            "native" | "rust" => Some(GrassSource::Native),
            "webview" | "tap" | "js" => Some(GrassSource::Webview),
            _ => None,
        }
    }
}

static SOURCE: AtomicU8 = AtomicU8::new(0);

pub fn source() -> GrassSource {
    if SOURCE.load(Ordering::Relaxed) == 1 {
        GrassSource::Webview
    } else {
        GrassSource::Native
    }
}

/// Returns false (and changes nothing) for an unknown name.
pub fn set_source(name: &str) -> bool {
    match GrassSource::parse(name) {
        Some(s) => {
            SOURCE.store(if s == GrassSource::Webview { 1 } else { 0 }, Ordering::Relaxed);
            true
        }
        None => false,
    }
}

// ── state ───────────────────────────────────────────────────────────────

static CONNECTED: AtomicBool = AtomicBool::new(false);
static LAST_MSG_MS: AtomicU64 = AtomicU64::new(0);
static MSGS_TOTAL: AtomicU64 = AtomicU64::new(0);
static MSGS_MINUTE: AtomicU64 = AtomicU64::new(0);
static MSGS_LAST_MINUTE: AtomicU64 = AtomicU64::new(0);
static MINUTE_INDEX: AtomicU64 = AtomicU64::new(0);
static RECONNECTS: AtomicU64 = AtomicU64::new(0);
static SLOW_CONSUMER: AtomicU64 = AtomicU64::new(0);
static WEBVIEW_SUPPRESSED: AtomicU64 = AtomicU64::new(0);
static CONNECTED_URL: LazyLock<Mutex<String>> = LazyLock::new(|| Mutex::new(String::new()));
static LAST_ERROR: LazyLock<Mutex<Option<String>>> = LazyLock::new(|| Mutex::new(None));

/// How long after the last message the native stream still counts as the
/// authority that silences the webview tap's duplicates. The block heartbeat
/// alone is one message every ~6 s, so a minute of silence means trouble.
const AUTHORITATIVE_WINDOW_MS: u64 = 60_000;
/// No message for this long on a connection the client still calls open:
/// tear it down and connect afresh rather than trust the client's view.
const IDLE_RECONNECT_MS: u64 = 180_000;
const BACKOFF_MIN_MS: u64 = 1_000;
const BACKOFF_MAX_MS: u64 = 30_000;

fn now_ms() -> u64 {
    crate::hasher::types::now_millis() as u64
}

fn set_error(e: impl Into<String>) {
    *LAST_ERROR.lock().unwrap_or_else(|p| p.into_inner()) = Some(e.into());
}

/// Whether the native stream is currently the source of record — connected
/// and heard from within the last minute. `push_game_event` drops the
/// webview tap's copies while this is true (except `tx_settled`, which the
/// signer produces and only the webview can deliver).
pub fn authoritative() -> bool {
    source() == GrassSource::Native
        && CONNECTED.load(Ordering::Relaxed)
        && now_ms().saturating_sub(LAST_MSG_MS.load(Ordering::Relaxed)) <= AUTHORITATIVE_WINDOW_MS
}

pub fn note_webview_suppressed() {
    WEBVIEW_SUPPRESSED.fetch_add(1, Ordering::Relaxed);
}

fn count_message() {
    let now = now_ms();
    LAST_MSG_MS.store(now, Ordering::Relaxed);
    MSGS_TOTAL.fetch_add(1, Ordering::Relaxed);
    let minute = now / 60_000;
    let prev = MINUTE_INDEX.load(Ordering::Relaxed);
    if minute != prev && MINUTE_INDEX.compare_exchange(prev, minute, Ordering::SeqCst, Ordering::Relaxed).is_ok() {
        MSGS_LAST_MINUTE.store(MSGS_MINUTE.swap(0, Ordering::Relaxed), Ordering::Relaxed);
    }
    MSGS_MINUTE.fetch_add(1, Ordering::Relaxed);
}

pub fn health() -> Value {
    let last = LAST_MSG_MS.load(Ordering::Relaxed);
    json!({
        "mode": source().name(),
        "connected": CONNECTED.load(Ordering::Relaxed),
        "authoritative": authoritative(),
        "url": CONNECTED_URL.lock().unwrap_or_else(|p| p.into_inner()).clone(),
        "last_msg_age_s": if last == 0 { Value::Null } else { json!(now_ms().saturating_sub(last) / 1000) },
        "msgs_total": MSGS_TOTAL.load(Ordering::Relaxed),
        "msgs_last_minute": MSGS_LAST_MINUTE.load(Ordering::Relaxed),
        "reconnects": RECONNECTS.load(Ordering::Relaxed),
        "slow_consumer_drops": SLOW_CONSUMER.load(Ordering::Relaxed),
        "webview_suppressed": WEBVIEW_SUPPRESSED.load(Ordering::Relaxed),
        "last_error": LAST_ERROR.lock().unwrap_or_else(|p| p.into_inner()).clone(),
    })
}

// ── payload → event ─────────────────────────────────────────────────────

/// A GRASS payload as the webview tap would forward it: `category` required;
/// `subject` from the payload, else the NATS subject; `detail` = every other
/// top-level field folded in first (inventory events carry `amount` at the
/// top), then the structured `detail` keys, which win on conflict.
pub fn event_from_payload(nats_subject: &str, payload: &[u8]) -> Option<GameEvent> {
    let v: Value = serde_json::from_slice(payload).ok()?;
    let obj = v.as_object()?;
    let category = obj.get("category")?.as_str()?.to_string();
    if category.is_empty() {
        return None;
    }
    let subject = obj
        .get("subject")
        .and_then(|s| s.as_str())
        .filter(|s| !s.is_empty())
        .unwrap_or(nats_subject)
        .to_string();
    let mut detail = Map::new();
    for (k, val) in obj {
        if k != "category" && k != "subject" && k != "detail" {
            detail.insert(k.clone(), val.clone());
        }
    }
    if let Some(Value::Object(d)) = obj.get("detail") {
        for (k, val) in d {
            detail.insert(k.clone(), val.clone());
        }
    }
    Some(GameEvent { category, subject, detail: Value::Object(detail), timestamp: now_ms() as f64 })
}

// ── supervisor ──────────────────────────────────────────────────────────

fn configured_url() -> Option<String> {
    crate::guild_config::get_active_guild_config()
        .map(|c| c.grass_nats_ws)
        .filter(|u| !u.is_empty())
}

/// Spawn the supervisor. Idempotent per process (a second call is a no-op).
pub fn init(app: tauri::AppHandle) {
    static STARTED: AtomicBool = AtomicBool::new(false);
    if STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    tauri::async_runtime::spawn(async move { supervise(app).await });
}

async fn supervise(app: tauri::AppHandle) {
    let mut backoff = BACKOFF_MIN_MS;
    loop {
        if source() != GrassSource::Native {
            CONNECTED.store(false, Ordering::Relaxed);
            tokio::time::sleep(Duration::from_secs(5)).await;
            continue;
        }
        let Some(url) = configured_url() else {
            tokio::time::sleep(Duration::from_secs(5)).await;
            continue;
        };
        match run_connection(&app, &url).await {
            Ok(()) => {
                backoff = BACKOFF_MIN_MS;
            }
            Err(e) => {
                set_error(e.clone());
                tlog("grass", Sev::Warn, format!("native GRASS {url}: {e} — reconnecting in {}s", backoff / 1000));
                tokio::time::sleep(Duration::from_millis(backoff)).await;
                backoff = (backoff * 2).min(BACKOFF_MAX_MS);
            }
        }
        CONNECTED.store(false, Ordering::Relaxed);
        RECONNECTS.fetch_add(1, Ordering::Relaxed);
    }
}

/// One client's lifetime. `async-nats` reconnects and re-subscribes on its
/// own inside this; we only tear it down for a guild switch, the knob, an
/// idle socket, or a stream that ends. Ok = benign end, Err = the cause.
async fn run_connection(app: &tauri::AppHandle, url: &str) -> Result<(), String> {
    let client = async_nats::ConnectOptions::new()
        .name("structs-desktop")
        .connection_timeout(Duration::from_secs(20))
        .ping_interval(Duration::from_secs(30))
        .max_reconnects(None)
        .event_callback(|event| async move {
            match event {
                async_nats::Event::Connected => {
                    CONNECTED.store(true, Ordering::Relaxed);
                    tlog("grass", Sev::Info, "native GRASS: client reconnected");
                }
                async_nats::Event::Disconnected => {
                    CONNECTED.store(false, Ordering::Relaxed);
                    RECONNECTS.fetch_add(1, Ordering::Relaxed);
                    tlog("grass", Sev::Warn, "native GRASS: client disconnected — reconnecting");
                }
                async_nats::Event::SlowConsumer(n) => {
                    SLOW_CONSUMER.fetch_add(n.max(1), Ordering::Relaxed);
                    tlog("grass", Sev::Warn, format!("native GRASS: slow consumer, {n} messages dropped by the client"));
                }
                async_nats::Event::ServerError(e) => {
                    set_error(format!("server error: {e}"));
                    tlog("grass", Sev::Warn, format!("native GRASS: server error: {e}"));
                }
                async_nats::Event::ClientError(e) => {
                    set_error(format!("client error: {e}"));
                    tlog("grass", Sev::Warn, format!("native GRASS: client error: {e}"));
                }
                other => {
                    tlog("grass", Sev::Info, format!("native GRASS: {other}"));
                }
            }
        })
        .connect(url)
        .await
        .map_err(|e| format!("connect: {e}"))?;

    let planets = client.subscribe("structs.>").await.map_err(|e| format!("subscribe structs.>: {e}"))?;
    let blocks = client.subscribe("consensus").await.map_err(|e| format!("subscribe consensus: {e}"))?;
    let mut stream = futures_util::stream::select(planets, blocks);

    *CONNECTED_URL.lock().unwrap_or_else(|p| p.into_inner()) = url.to_string();
    CONNECTED.store(true, Ordering::Relaxed);
    *LAST_ERROR.lock().unwrap_or_else(|p| p.into_inner()) = None;
    tlog("grass", Sev::Info, format!("native GRASS connected: {url} (structs.> + consensus)"));

    let mut last_rx = now_ms();
    loop {
        let next = tokio::time::timeout(Duration::from_secs(10), stream.next()).await;
        // Housekeeping on every tick, message or not.
        if source() != GrassSource::Native {
            tlog("grass", Sev::Info, "native GRASS: knob set to webview — disconnecting");
            let _ = client.drain().await;
            return Ok(());
        }
        if configured_url().as_deref() != Some(url) {
            tlog("grass", Sev::Info, "native GRASS: guild endpoint changed — reconnecting");
            let _ = client.drain().await;
            return Ok(());
        }
        let msg = match next {
            Ok(Some(m)) => m,
            Ok(None) => return Err("subscription ended".into()),
            Err(_) => {
                if now_ms().saturating_sub(last_rx) > IDLE_RECONNECT_MS {
                    let _ = client.drain().await;
                    return Err(format!("no traffic for {}s", IDLE_RECONNECT_MS / 1000));
                }
                continue;
            }
        };
        last_rx = now_ms();
        count_message();
        if let Some(event) = event_from_payload(msg.subject.as_str(), &msg.payload) {
            crate::mcp::event_buffer::ingest(app, event);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn payload_becomes_the_event_the_webview_tap_would_have_forwarded() {
        let payload = br#"{"subject":"structs.planet.2-28299.1-1053","category":"struct_status","seq":34,"time":"t","block_height":2472051,"detail":{"status":7,"status_old":1,"struct_id":"5-240228"}}"#;
        let e = event_from_payload("structs.planet.2-28299.1-1053", payload).unwrap();
        assert_eq!(e.category, "struct_status");
        assert_eq!(e.subject, "structs.planet.2-28299.1-1053");
        assert_eq!(e.detail["seq"], 34);
        assert_eq!(e.detail["block_height"], 2472051);
        assert_eq!(e.detail["struct_id"], "5-240228");
        assert!(e.detail.get("category").is_none(), "category is not folded into detail");
        assert!(e.detail.get("detail").is_none());
        // detail keys win over top-level ones of the same name
        let payload = br#"{"category":"mined","amount":3,"detail":{"amount":5}}"#;
        let e = event_from_payload("structs.inventory.1-2", payload).unwrap();
        assert_eq!(e.detail["amount"], 5);
        assert_eq!(e.subject, "structs.inventory.1-2", "NATS subject fills in when the payload has none");
        // the block heartbeat on `consensus`
        let e = event_from_payload("consensus", br#"{"category":"block","height":2472134}"#).unwrap();
        assert_eq!(e.category, "block");
        assert_eq!(e.detail["height"], 2472134);
        // no category → not an event
        assert!(event_from_payload("x", br#"{"height":1}"#).is_none());
        assert!(event_from_payload("x", b"not json").is_none());
    }

    /// Live: one frame from production over the WebSocket transport.
    /// `cargo test --bin structs-app -- --ignored live_native_grass`
    #[tokio::test]
    #[ignore]
    async fn live_native_grass_receives_a_frame() {
        let client = async_nats::ConnectOptions::new()
            .name("structs-desktop-test")
            .connection_timeout(Duration::from_secs(20))
            .connect("wss://crew.oh.energy:1443")
            .await
            .expect("connect");
        let mut sub = client.subscribe("consensus").await.expect("subscribe");
        let msg = tokio::time::timeout(Duration::from_secs(30), sub.next()).await.expect("a block within 30 s").expect("stream open");
        let e = event_from_payload(msg.subject.as_str(), &msg.payload).expect("block payload is an event");
        assert_eq!(e.category, "block");
        assert!(e.detail["height"].as_u64().unwrap_or(0) > 2_400_000);
    }

    #[test]
    fn knob_names() {
        assert!(set_source("webview"));
        assert_eq!(source(), GrassSource::Webview);
        assert!(!authoritative(), "webview mode is never authoritative");
        assert!(set_source("native"));
        assert_eq!(source(), GrassSource::Native);
        assert!(!set_source("carrier-pigeon"));
        assert_eq!(source(), GrassSource::Native);
    }
}
