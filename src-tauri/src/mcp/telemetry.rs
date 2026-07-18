//! Persistent operational telemetry: a single SQLite database (`state.db`,
//! WAL) holding structured events, loop liveness rows, a transaction-attempt
//! ledger, and proof-of-work solve history. JSON configs remain the source of
//! *intent*; this DB is the system's memory of *what happened* — it powers the
//! watchdog, the adaptive controllers, and the `structs_system` MCP tool.
//!
//! Writes never block gameplay: producers `try_send` onto a bounded channel
//! consumed by one dedicated writer thread that batches inserts per
//! transaction. If the DB can't be opened, everything degrades to the
//! pre-existing eprintln-only behavior (persistence is best-effort, matching
//! `config_store::save_config`).

use rusqlite::Connection;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, SyncSender, TrySendError};
use std::sync::{Arc, LazyLock};

use crate::hasher::types::now_millis;
use crate::mcp::board_feed;
use crate::mcp::config_store;

// ── Severity ──

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Sev {
    Debug,
    Info,
    Notice,
    Warn,
    Error,
}

impl Sev {
    pub fn as_str(self) -> &'static str {
        match self {
            Sev::Debug => "debug",
            Sev::Info => "info",
            Sev::Notice => "notice",
            Sev::Warn => "warn",
            Sev::Error => "error",
        }
    }

    /// Parse a severity name (for MCP filter params); unknown → None.
    pub fn parse(s: &str) -> Option<Self> {
        match s.to_ascii_lowercase().as_str() {
            "debug" => Some(Sev::Debug),
            "info" => Some(Sev::Info),
            "notice" => Some(Sev::Notice),
            "warn" | "warning" => Some(Sev::Warn),
            "error" => Some(Sev::Error),
            _ => None,
        }
    }
}

// ── Rows / messages ──

struct EventRow {
    ts_ms: f64,
    component: &'static str,
    severity: &'static str,
    message: String,
    kv: Option<String>,
}

pub struct TxAttemptRow {
    pub ts_ms: f64,
    pub context: String,
    pub action: String,
    pub player_id: Option<String>,
    pub attempt: u32,
    pub outcome: &'static str,
    pub tx_hash: Option<String>,
    pub code: Option<i64>,
    pub raw_error: Option<String>,
    pub translated: Option<String>,
    pub duration_ms: f64,
}

pub struct PowSolveRow {
    pub ts_ms: f64,
    pub object_id: String,
    pub task_type: String,
    pub engine: &'static str,
    pub difficulty: u64,
    pub difficulty_target: u64,
    pub duration_ms: f64,
    pub iterations: Option<u64>,
    pub hashrate: Option<f64>,
    pub struct_type: Option<String>,
}

enum Msg {
    Event(EventRow),
    LoopStart {
        run_id: i64,
        loop_name: &'static str,
        started_ms: f64,
    },
    LoopFinish {
        run_id: i64,
        finished_ms: f64,
        players: u32,
        actions: u32,
        errors: u32,
        notes: Option<String>,
    },
    TxAttempt(TxAttemptRow),
    PowSolve(PowSolveRow),
}

// ── Writer plumbing ──

/// Bounded queue between producers and the writer thread. 8192 messages
/// absorbs a full 182-player scan burst; overflow is dropped (counted).
const QUEUE_CAP: usize = 8192;
/// Max messages folded into one SQLite transaction.
const BATCH_MAX: usize = 256;
/// Retention sweep cadence: whichever comes first.
const RETENTION_EVERY_INSERTS: u64 = 10_000;
const RETENTION_EVERY_MS: f64 = 30.0 * 60_000.0;
/// Per-table retention windows.
const EVENTS_KEEP_MS: f64 = 7.0 * 86_400_000.0;
const EVENTS_MAX_ROWS: u64 = 200_000;
const LOOP_RUNS_KEEP_MS: f64 = 7.0 * 86_400_000.0;
const TX_KEEP_MS: f64 = 14.0 * 86_400_000.0;
const POW_KEEP_MS: f64 = 30.0 * 86_400_000.0;

static WRITER: LazyLock<Option<SyncSender<Msg>>> = LazyLock::new(init_writer);
/// Messages dropped because the queue was full (or the writer died) —
/// surfaced by `structs_system status` so backpressure is never silent.
static DROPPED: AtomicU64 = AtomicU64::new(0);
/// Client-side run_id disambiguator (see `next_run_id`).
static RUN_SEQ: AtomicU32 = AtomicU32::new(0);

pub fn dropped_count() -> u64 {
    DROPPED.load(Ordering::Relaxed)
}

pub fn db_path() -> Option<std::path::PathBuf> {
    config_store::config_path("state.db")
}

fn init_writer() -> Option<SyncSender<Msg>> {
    let path = db_path()?;
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let (tx, rx) = std::sync::mpsc::sync_channel::<Msg>(QUEUE_CAP);
    std::thread::Builder::new()
        .name("telemetry-writer".into())
        .spawn(move || writer_loop(path, rx))
        .ok()?;
    Some(tx)
}

fn send(msg: Msg) {
    match WRITER.as_ref() {
        Some(tx) => match tx.try_send(msg) {
            Ok(()) => {}
            Err(TrySendError::Full(_)) | Err(TrySendError::Disconnected(_)) => {
                DROPPED.fetch_add(1, Ordering::Relaxed);
            }
        },
        None => {
            DROPPED.fetch_add(1, Ordering::Relaxed);
        }
    }
}

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS events (
  id        INTEGER PRIMARY KEY,
  ts_ms     REAL    NOT NULL,
  component TEXT    NOT NULL,
  severity  TEXT    NOT NULL,
  message   TEXT    NOT NULL,
  kv        TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_ts      ON events(ts_ms);
CREATE INDEX IF NOT EXISTS idx_events_comp_ts ON events(component, ts_ms);

CREATE TABLE IF NOT EXISTS loop_runs (
  run_id          INTEGER PRIMARY KEY,
  loop_name       TEXT NOT NULL,
  started_ms      REAL NOT NULL,
  finished_ms     REAL,
  players_scanned INTEGER NOT NULL DEFAULT 0,
  actions_fired   INTEGER NOT NULL DEFAULT 0,
  errors          INTEGER NOT NULL DEFAULT 0,
  notes           TEXT
);
CREATE INDEX IF NOT EXISTS idx_loop_runs_name ON loop_runs(loop_name, started_ms);

CREATE TABLE IF NOT EXISTS tx_attempts (
  id          INTEGER PRIMARY KEY,
  ts_ms       REAL NOT NULL,
  context     TEXT NOT NULL,
  action      TEXT NOT NULL,
  player_id   TEXT,
  attempt     INTEGER NOT NULL DEFAULT 1,
  outcome     TEXT NOT NULL,
  tx_hash     TEXT,
  code        INTEGER,
  raw_error   TEXT,
  translated  TEXT,
  duration_ms REAL
);
CREATE INDEX IF NOT EXISTS idx_tx_ts  ON tx_attempts(ts_ms);
CREATE INDEX IF NOT EXISTS idx_tx_ctx ON tx_attempts(context, ts_ms);

CREATE TABLE IF NOT EXISTS pow_solves (
  id                INTEGER PRIMARY KEY,
  ts_ms             REAL NOT NULL,
  object_id         TEXT NOT NULL,
  task_type         TEXT NOT NULL,
  engine            TEXT NOT NULL,
  difficulty        INTEGER NOT NULL,
  difficulty_target INTEGER NOT NULL,
  duration_ms       REAL NOT NULL,
  iterations        INTEGER,
  hashrate          REAL,
  struct_type       TEXT
);
CREATE INDEX IF NOT EXISTS idx_pow_ts ON pow_solves(ts_ms);
";

fn open_writer_conn(path: &std::path::Path) -> Result<Connection, rusqlite::Error> {
    let conn = Connection::open(path)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.pragma_update(None, "busy_timeout", 2000)?;
    conn.execute_batch(SCHEMA)?;
    // Schema version for future migrations (0 = fresh; 1 = current layout).
    let ver: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if ver < 1 {
        conn.pragma_update(None, "user_version", 1)?;
    }
    Ok(conn)
}

fn writer_loop(path: std::path::PathBuf, rx: Receiver<Msg>) {
    let conn = match open_writer_conn(&path) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[Structs Telemetry] cannot open {}: {e} — persistence disabled", path.display());
            // Drain forever so senders see a live channel and try_send stays cheap.
            for _ in rx {
                DROPPED.fetch_add(1, Ordering::Relaxed);
            }
            return;
        }
    };
    let mut inserts_since_sweep: u64 = 0;
    let mut last_sweep_ms = now_millis();

    while let Ok(first) = rx.recv() {
        let mut batch = vec![first];
        while batch.len() < BATCH_MAX {
            match rx.try_recv() {
                Ok(m) => batch.push(m),
                Err(_) => break,
            }
        }
        let n = batch.len() as u64;
        if let Err(e) = apply_batch(&conn, batch) {
            eprintln!("[Structs Telemetry] write failed: {e}");
        }
        inserts_since_sweep += n;

        let now = now_millis();
        if inserts_since_sweep >= RETENTION_EVERY_INSERTS || now - last_sweep_ms >= RETENTION_EVERY_MS {
            if let Err(e) = sweep_retention(&conn, now) {
                eprintln!("[Structs Telemetry] retention sweep failed: {e}");
            }
            inserts_since_sweep = 0;
            last_sweep_ms = now;
        }
    }
}

fn apply_batch(conn: &Connection, batch: Vec<Msg>) -> Result<(), rusqlite::Error> {
    conn.execute_batch("BEGIN")?;
    let res = (|| -> Result<(), rusqlite::Error> {
        for msg in batch {
            match msg {
                Msg::Event(e) => {
                    conn.execute(
                        "INSERT INTO events (ts_ms, component, severity, message, kv) VALUES (?1,?2,?3,?4,?5)",
                        rusqlite::params![e.ts_ms, e.component, e.severity, e.message, e.kv],
                    )?;
                }
                Msg::LoopStart { run_id, loop_name, started_ms } => {
                    conn.execute(
                        "INSERT OR IGNORE INTO loop_runs (run_id, loop_name, started_ms) VALUES (?1,?2,?3)",
                        rusqlite::params![run_id, loop_name, started_ms],
                    )?;
                }
                Msg::LoopFinish { run_id, finished_ms, players, actions, errors, notes } => {
                    conn.execute(
                        "UPDATE loop_runs SET finished_ms=?2, players_scanned=?3, actions_fired=?4, errors=?5, notes=?6 WHERE run_id=?1",
                        rusqlite::params![run_id, finished_ms, players, actions, errors, notes],
                    )?;
                }
                Msg::TxAttempt(t) => {
                    conn.execute(
                        "INSERT INTO tx_attempts (ts_ms, context, action, player_id, attempt, outcome, tx_hash, code, raw_error, translated, duration_ms)
                         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
                        rusqlite::params![
                            t.ts_ms, t.context, t.action, t.player_id, t.attempt, t.outcome,
                            t.tx_hash, t.code, t.raw_error, t.translated, t.duration_ms
                        ],
                    )?;
                }
                Msg::PowSolve(p) => {
                    conn.execute(
                        "INSERT INTO pow_solves (ts_ms, object_id, task_type, engine, difficulty, difficulty_target, duration_ms, iterations, hashrate, struct_type)
                         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
                        rusqlite::params![
                            p.ts_ms, p.object_id, p.task_type, p.engine, p.difficulty as i64,
                            p.difficulty_target as i64, p.duration_ms,
                            p.iterations.map(|v| v as i64), p.hashrate, p.struct_type
                        ],
                    )?;
                }
            }
        }
        Ok(())
    })();
    match res {
        Ok(()) => conn.execute_batch("COMMIT"),
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(e)
        }
    }
}

fn sweep_retention(conn: &Connection, now: f64) -> Result<(), rusqlite::Error> {
    conn.execute("DELETE FROM events WHERE ts_ms < ?1", [now - EVENTS_KEEP_MS])?;
    // Row cap on events, oldest first.
    conn.execute(
        "DELETE FROM events WHERE id IN (
           SELECT id FROM events ORDER BY id DESC LIMIT -1 OFFSET ?1
         )",
        [EVENTS_MAX_ROWS as i64],
    )?;
    conn.execute("DELETE FROM loop_runs WHERE started_ms < ?1", [now - LOOP_RUNS_KEEP_MS])?;
    conn.execute("DELETE FROM tx_attempts WHERE ts_ms < ?1", [now - TX_KEEP_MS])?;
    conn.execute("DELETE FROM pow_solves WHERE ts_ms < ?1", [now - POW_KEEP_MS])?;
    let _ = conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)");
    Ok(())
}

// ── Log facade ──

/// Console prefix for a component — keeps stderr output byte-identical to the
/// historical hand-written prefixes so existing grep habits keep working.
fn prefix(component: &str) -> String {
    match component {
        "auto_build" => "[Auto-Build]".into(),
        "auto_defend" => "[Auto-Defend]".into(),
        "auto_harvest" => "[Auto-Harvest]".into(),
        "auto_infuse" => "[Auto-Infuse]".into(),
        "auto" => "[Structs Auto]".into(),
        "tx" => "[Structs TX]".into(),
        "vplayer" => "[Structs VPlayer]".into(),
        "conn" => "[Structs Conn]".into(),
        "sync" => "[Structs Sync]".into(),
        "hasher" => "[Structs Hasher]".into(),
        "mcp" => "[Structs MCP]".into(),
        other => format!("[Structs {other}]"),
    }
}

/// Log to stderr (existing behavior) AND the persistent events table.
/// Sync, non-blocking, callable from any thread.
pub fn tlog(component: &'static str, sev: Sev, msg: impl AsRef<str>) {
    let msg = msg.as_ref();
    eprintln!("{} {}", prefix(component), msg);
    send(Msg::Event(EventRow {
        ts_ms: now_millis(),
        component,
        severity: sev.as_str(),
        message: msg.to_string(),
        kv: None,
    }));
}

/// `tlog` with structured fields persisted as a JSON object in `events.kv`.
pub fn tlog_kv(component: &'static str, sev: Sev, msg: impl AsRef<str>, kv: Value) {
    let msg = msg.as_ref();
    eprintln!("{} {} {}", prefix(component), msg, kv);
    send(Msg::Event(EventRow {
        ts_ms: now_millis(),
        component,
        severity: sev.as_str(),
        message: msg.to_string(),
        kv: Some(kv.to_string()),
    }));
}

/// `tlog` that also lands in the Team Ops board feed so the player sees it.
/// Warn maps to a Notice entry, Error to Important (which keeps the existing
/// consent-gated auto-open behavior in `board_feed::push`).
pub fn tlog_feed(app: &tauri::AppHandle, component: &'static str, sev: Sev, msg: impl AsRef<str>) {
    let m = msg.as_ref().to_string();
    tlog(component, sev, &m);
    let feed_sev = match sev {
        Sev::Error => board_feed::Severity::Important,
        Sev::Warn => board_feed::Severity::Notice,
        _ => board_feed::Severity::Info,
    };
    board_feed::push(app, feed_sev, component, m);
}

// ── Loop liveness handles ──

/// Client-generated primary key: ms timestamp × 1000 plus a wrapping counter,
/// so `LoopFinish` is a fire-and-forget UPDATE with no read round-trip.
fn next_run_id() -> i64 {
    (now_millis() as i64) * 1000 + (RUN_SEQ.fetch_add(1, Ordering::Relaxed) % 1000) as i64
}

/// One scan of one loop. Counters are atomics so the per-player bodies running
/// under `for_each_player_concurrent` can tally without locks.
pub struct LoopRun {
    run_id: i64,
    pub loop_name: &'static str,
    pub started_ms: f64,
    pub players: AtomicU32,
    pub actions: AtomicU32,
    pub errors: AtomicU32,
}

impl LoopRun {
    pub fn start(loop_name: &'static str) -> Arc<LoopRun> {
        let started_ms = now_millis();
        let run_id = next_run_id();
        send(Msg::LoopStart { run_id, loop_name, started_ms });
        crate::mcp::watchdog::note_loop_started(loop_name, started_ms);
        Arc::new(LoopRun {
            run_id,
            loop_name,
            started_ms,
            players: AtomicU32::new(0),
            actions: AtomicU32::new(0),
            errors: AtomicU32::new(0),
        })
    }

    pub fn finish(&self, notes: Option<String>) {
        let finished_ms = self.record_finish(notes);
        crate::mcp::watchdog::note_loop_finished(self.loop_name, finished_ms);
    }

    /// Finish for a scan that was INVALIDATED mid-flight (a watchdog reset
    /// bumped the loop's run generation and a newer scan may already own the
    /// single-flight guard). Persists the SQLite row for the audit trail but
    /// does NOT touch the watchdog's liveness mirror — the newer scan's
    /// start/finish is the truth now.
    pub fn finish_stale(&self, notes: Option<String>) {
        self.record_finish(notes);
    }

    fn record_finish(&self, notes: Option<String>) -> f64 {
        let finished_ms = now_millis();
        send(Msg::LoopFinish {
            run_id: self.run_id,
            finished_ms,
            players: self.players.load(Ordering::Relaxed),
            actions: self.actions.load(Ordering::Relaxed),
            errors: self.errors.load(Ordering::Relaxed),
            notes,
        });
        finished_ms
    }
}

// ── Direct recorders ──

pub fn record_tx_attempt(row: TxAttemptRow) {
    send(Msg::TxAttempt(row));
}

pub fn record_pow_solve(row: PowSolveRow) {
    send(Msg::PowSolve(row));
}

/// Record a completed proof-of-work solve from a task snapshot. Called from
/// the CPU/GPU completion paths; ignores snapshots without a real result.
pub fn record_solve(snap: &crate::hasher::types::TaskStateSnapshot, engine: &'static str) {
    if !snap.result_exists {
        return;
    }
    let end = snap.process_end_time.unwrap_or(snap.last_status_change_time);
    let duration_ms = (end - snap.process_start_time).max(0.0);
    let struct_type = crate::game_state::GAME_STATE
        .read()
        .ok()
        .and_then(|gs| gs.get_struct_type_name(&snap.object_id));
    record_pow_solve(PowSolveRow {
        ts_ms: now_millis(),
        object_id: snap.object_id.clone(),
        task_type: snap.task_type.clone().unwrap_or_default(),
        engine,
        difficulty: snap.result_difficulty,
        difficulty_target: snap.difficulty_target,
        duration_ms,
        iterations: Some(snap.iterations),
        hashrate: Some(snap.estimated_hashrate),
        struct_type,
    });
}

// ── Query API (read-only; call via spawn_blocking from async contexts) ──

fn open_read() -> Result<Connection, String> {
    let path = db_path().ok_or("no config dir")?;
    Connection::open_with_flags(
        &path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| format!("telemetry db unavailable: {e}"))
}

pub struct EventFilter {
    pub component: Option<String>,
    pub severity_min: Option<Sev>,
    pub since_ms: Option<f64>,
    pub limit: usize,
}

/// Events matching the filter, newest first.
pub fn query_events(f: &EventFilter) -> Result<Vec<Value>, String> {
    let conn = open_read()?;
    // severity is stored as text; rank it for the min filter.
    let mut sql = String::from(
        "SELECT ts_ms, component, severity, message, kv FROM events WHERE 1=1",
    );
    let mut params: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
    if let Some(c) = &f.component {
        sql.push_str(" AND component = ?");
        params.push(Box::new(c.clone()));
    }
    if let Some(min) = f.severity_min {
        let allowed: Vec<&str> = [Sev::Debug, Sev::Info, Sev::Notice, Sev::Warn, Sev::Error]
            .iter()
            .filter(|s| **s >= min)
            .map(|s| s.as_str())
            .collect();
        sql.push_str(&format!(
            " AND severity IN ({})",
            allowed.iter().map(|_| "?").collect::<Vec<_>>().join(",")
        ));
        for a in allowed {
            params.push(Box::new(a.to_string()));
        }
    }
    if let Some(since) = f.since_ms {
        sql.push_str(" AND ts_ms >= ?");
        params.push(Box::new(since));
    }
    sql.push_str(" ORDER BY id DESC LIMIT ?");
    params.push(Box::new(f.limit.min(1000) as i64));

    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params_from_iter(params.iter().map(|p| p.as_ref())), |r| {
            let kv: Option<String> = r.get(4)?;
            Ok(json!({
                "ts_ms": r.get::<_, f64>(0)?,
                "component": r.get::<_, String>(1)?,
                "severity": r.get::<_, String>(2)?,
                "message": r.get::<_, String>(3)?,
                "kv": kv.and_then(|s| serde_json::from_str::<Value>(&s).ok()),
            }))
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// Per-loop health over a window: last run, average duration, error rate.
pub fn loop_health(window_ms: f64) -> Result<Vec<Value>, String> {
    let conn = open_read()?;
    let since = now_millis() - window_ms;
    let mut stmt = conn
        .prepare(
            "SELECT loop_name,
                    COUNT(*) AS runs,
                    MAX(started_ms) AS last_started,
                    MAX(finished_ms) AS last_finished,
                    AVG(CASE WHEN finished_ms IS NOT NULL THEN finished_ms - started_ms END) AS avg_duration_ms,
                    SUM(errors) AS errors,
                    SUM(actions_fired) AS actions,
                    SUM(players_scanned) AS players,
                    SUM(CASE WHEN finished_ms IS NULL THEN 1 ELSE 0 END) AS unfinished
             FROM loop_runs WHERE started_ms >= ?1 GROUP BY loop_name",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([since], |r| {
            Ok(json!({
                "loop": r.get::<_, String>(0)?,
                "runs": r.get::<_, i64>(1)?,
                "last_started_ms": r.get::<_, Option<f64>>(2)?,
                "last_finished_ms": r.get::<_, Option<f64>>(3)?,
                "avg_duration_ms": r.get::<_, Option<f64>>(4)?,
                "errors": r.get::<_, i64>(5)?,
                "actions": r.get::<_, i64>(6)?,
                "players": r.get::<_, i64>(7)?,
                "unfinished_runs": r.get::<_, i64>(8)?,
            }))
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// Per-context tx outcomes over a window plus the most common failure reasons.
/// Recent tx attempts, newest first — per-row detail (unlike `tx_summary`'s
/// aggregates). Feeds the board TX page's RECENT RESULTS section; covers the
/// vplayer fire-and-forget txs that never enter the primary's signing queue.
pub fn tx_attempts_recent(limit: usize) -> Result<Vec<Value>, String> {
    let conn = open_read()?;
    let mut stmt = conn
        .prepare(
            "SELECT ts_ms, context, action, player_id, attempt, outcome,
                    tx_hash, code, raw_error, translated, duration_ms
             FROM tx_attempts ORDER BY id DESC LIMIT ?1",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([limit.min(200) as i64], |r| {
            Ok(serde_json::json!({
                "ts_ms": r.get::<_, f64>(0)?,
                "context": r.get::<_, String>(1)?,
                "action": r.get::<_, String>(2)?,
                "player_id": r.get::<_, Option<String>>(3)?,
                "attempt": r.get::<_, i64>(4)?,
                "outcome": r.get::<_, String>(5)?,
                "tx_hash": r.get::<_, Option<String>>(6)?,
                "code": r.get::<_, Option<i64>>(7)?,
                "raw_error": r.get::<_, Option<String>>(8)?,
                "translated": r.get::<_, Option<String>>(9)?,
                "duration_ms": r.get::<_, Option<f64>>(10)?,
            }))
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    Ok(rows)
}

pub fn tx_summary(window_ms: f64) -> Result<Value, String> {
    let conn = open_read()?;
    let since = now_millis() - window_ms;
    let mut by_ctx = Vec::new();
    {
        let mut stmt = conn
            .prepare(
                "SELECT context,
                        COUNT(*) AS attempts,
                        SUM(CASE WHEN outcome='success' THEN 1 ELSE 0 END) AS successes,
                        SUM(CASE WHEN outcome IN ('chain_error','timeout','bridge_error','rate_limited') THEN 1 ELSE 0 END) AS failures,
                        SUM(CASE WHEN outcome='skipped' THEN 1 ELSE 0 END) AS skipped
                 FROM tx_attempts WHERE ts_ms >= ?1 GROUP BY context ORDER BY attempts DESC LIMIT 50",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([since], |r| {
                Ok(json!({
                    "context": r.get::<_, String>(0)?,
                    "attempts": r.get::<_, i64>(1)?,
                    "successes": r.get::<_, i64>(2)?,
                    "failures": r.get::<_, i64>(3)?,
                    "skipped": r.get::<_, i64>(4)?,
                }))
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            by_ctx.push(row.map_err(|e| e.to_string())?);
        }
    }
    let mut top_errors = Vec::new();
    {
        let mut stmt = conn
            .prepare(
                "SELECT COALESCE(translated, raw_error, outcome) AS reason, COUNT(*) AS n
                 FROM tx_attempts WHERE ts_ms >= ?1 AND outcome != 'success'
                 GROUP BY reason ORDER BY n DESC LIMIT 10",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([since], |r| {
                Ok(json!({ "reason": r.get::<_, String>(0)?, "count": r.get::<_, i64>(1)? }))
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            top_errors.push(row.map_err(|e| e.to_string())?);
        }
    }
    Ok(json!({ "by_context": by_ctx, "top_errors": top_errors }))
}

/// Per-engine PoW solve statistics over a window (count, median/p90 duration,
/// median difficulty, estimated sustained hashrate).
pub fn pow_stats(window_ms: f64) -> Result<Value, String> {
    let conn = open_read()?;
    let since = now_millis() - window_ms;
    let mut stmt = conn
        .prepare(
            "SELECT engine, difficulty, duration_ms, iterations FROM pow_solves WHERE ts_ms >= ?1",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([since], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, f64>(2)?,
                r.get::<_, Option<i64>>(3)?,
            ))
        })
        .map_err(|e| e.to_string())?;

    use std::collections::HashMap;
    let mut per: HashMap<String, Vec<(i64, f64, Option<i64>)>> = HashMap::new();
    for row in rows {
        let (engine, diff, dur, iters) = row.map_err(|e| e.to_string())?;
        per.entry(engine).or_default().push((diff, dur, iters));
    }
    let mut out = Vec::new();
    for (engine, mut solves) in per {
        solves.sort_by(|a, b| a.1.total_cmp(&b.1));
        let n = solves.len();
        let median = solves[n / 2].1;
        let p90 = solves[(n * 9 / 10).min(n - 1)].1;
        let mut diffs: Vec<i64> = solves.iter().map(|s| s.0).collect();
        diffs.sort_unstable();
        // Sustained hashrate estimate from iterations/duration where available.
        let mut rate_num = 0.0;
        let mut rate_den = 0.0;
        for (_, dur, iters) in &solves {
            if let Some(i) = iters {
                rate_num += *i as f64;
                rate_den += dur / 1000.0;
            }
        }
        out.push(json!({
            "engine": engine,
            "solves": n,
            "median_duration_ms": median,
            "p90_duration_ms": p90,
            "median_difficulty": diffs[n / 2],
            "est_hashrate_hps": if rate_den > 0.0 { Some(rate_num / rate_den) } else { None },
        }));
    }
    Ok(json!(out))
}

/// Current DB file size in bytes (0 if missing) — for `structs_system status`.
pub fn db_size_bytes() -> u64 {
    db_path()
        .and_then(|p| std::fs::metadata(p).ok())
        .map(|m| m.len())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Sev ordering drives the severity_min filter — keep it total and stable.
    #[test]
    fn severity_ordering() {
        assert!(Sev::Debug < Sev::Info);
        assert!(Sev::Info < Sev::Notice);
        assert!(Sev::Notice < Sev::Warn);
        assert!(Sev::Warn < Sev::Error);
        assert_eq!(Sev::parse("WARNING"), Some(Sev::Warn));
        assert_eq!(Sev::parse("bogus"), None);
    }

    /// run_ids must be unique across a rapid burst (same-millisecond starts).
    #[test]
    fn run_ids_unique_in_burst() {
        let ids: Vec<i64> = (0..100).map(|_| next_run_id()).collect();
        let mut dedup = ids.clone();
        dedup.sort_unstable();
        dedup.dedup();
        assert_eq!(dedup.len(), ids.len());
    }
}
