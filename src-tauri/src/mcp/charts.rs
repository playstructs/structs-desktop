//! Charts: every series the app can plot, on one time grid.
//!
//! A chart is a list of `{source, metric, subject}`; this module knows what
//! exists (`terminal_chart_catalog`), answers a whole list at once on ONE
//! grid (`terminal_chart_series`), keeps the one series nobody else records
//! (the energy market, sampled here), and stores charts by name so ⌘K can
//! open them.
//!
//! Sources:
//!   stat    one object, one metric — the guild's stat store (7d raw, 30d 1h)
//!   galaxy  a metric summed over every object of a type — the store's aggregate
//!   bank    a guild token: alpha per token, collateral, supply — the app's own
//!           hourly samples (terminal-banks.json)
//!   market  the energy market: best/median alpha per kW·day, capacity for sale,
//!           offers; and per provider its rate and free capacity — sampled here
//!   chain   the last hour by block — the game-stats ring
//!
//! Every answer is resampled to `points` even slots: null before the first
//! sample, carried forward after (a reading nobody took is not a zero).

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::sync::{LazyLock, Mutex};

use crate::mcp::terminal::{locf, object_type_of, parse_num, stat_bucket_for, STAT_METRICS};

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

// ── The market sampler ───────────────────────────────────────────────────────

const MARKET_FILE: &str = "terminal-market.json";
/// Five-minute samples for thirty days.
const MARKET_RING: usize = 12 * 24 * 30;
const MARKET_MIN_GAP_MS: f64 = 5.0 * 60_000.0;

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct MarketRing {
    /// Galaxy-wide: `{ts_ms, best, median, open_capacity_mw, priced, offers}`.
    #[serde(default)]
    pub samples: Vec<Value>,
    /// provider id → `{ts_ms, rate, free_w, capacity_max}`.
    #[serde(default)]
    pub providers: BTreeMap<String, Vec<Value>>,
}
static MARKET: LazyLock<Mutex<MarketRing>> =
    LazyLock::new(|| Mutex::new(crate::mcp::config_store::load_config(MARKET_FILE)));

/// Record one reading of the market. Called by `terminal_market` with what it
/// just computed, and by the five-minute ticker; at most one sample per five
/// minutes either way, so a board full of market cards costs nothing extra.
pub fn note_market(m: &Value) {
    let now = crate::hasher::types::now_millis();
    let mut ring = lock(&MARKET);
    let due = ring
        .samples
        .last()
        .and_then(|l| l.get("ts_ms"))
        .and_then(|t| t.as_f64())
        .map(|t| now - t >= MARKET_MIN_GAP_MS)
        .unwrap_or(true);
    if !due {
        return;
    }
    let providers = m.get("providers").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    ring.samples.push(json!({
        "ts_ms": now,
        "best": m.get("best_alpha_per_kw_day").cloned().unwrap_or(Value::Null),
        "median": m.get("median_alpha_per_kw_day").cloned().unwrap_or(Value::Null),
        "open_capacity_mw": m.get("open_capacity_mw").cloned().unwrap_or(Value::Null),
        "priced": m.get("priced").cloned().unwrap_or(Value::Null),
        "offers": providers.len(),
    }));
    if ring.samples.len() > MARKET_RING {
        let drop = ring.samples.len() - MARKET_RING;
        ring.samples.drain(0..drop);
    }
    for p in &providers {
        let id = p.get("id").or_else(|| p.get("provider_id")).and_then(|v| v.as_str()).unwrap_or("");
        if id.is_empty() {
            continue;
        }
        let pr = p.get("provider").unwrap_or(&Value::Null);
        let cap_max = parse_num(pr.get("capacity_max"));
        let cap_used = parse_num(pr.get("capacity_used")).unwrap_or(0.0);
        let row = json!({
            "ts_ms": now,
            "rate": p.get("alpha_per_kw_day").cloned().unwrap_or(Value::Null),
            "free_w": cap_max.map(|c| (c - cap_used).max(0.0)),
            "capacity_max": cap_max,
        });
        let v = ring.providers.entry(id.to_string()).or_default();
        v.push(row);
        if v.len() > MARKET_RING {
            let drop = v.len() - MARKET_RING;
            v.drain(0..drop);
        }
    }
    crate::mcp::config_store::save_config(MARKET_FILE, &*ring);
}

/// The ticker: a market reading every five minutes whether or not a card is
/// open, so the history a player opens tonight exists. Failures are silent —
/// the next tick tries again.
pub fn spawn_market_sampler() {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(300)).await;
            if let Ok(m) = crate::mcp::terminal::terminal_market().await {
                note_market(&m);
            }
        }
    });
}

// ── The catalogue ────────────────────────────────────────────────────────────

const MARKET_METRICS: &[(&str, &str, &str)] = &[
    ("best", "rate", "best rate"),
    ("median", "rate", "median rate"),
    ("open_capacity_mw", "mw", "capacity for sale"),
    ("offers", "count", "offers"),
    ("priced", "count", "priced offers"),
];
const PROVIDER_METRICS: &[(&str, &str, &str)] = &[
    ("rate", "rate", "rate"),
    ("free_w", "power", "free capacity"),
    ("capacity_max", "power", "capacity"),
];
const BANK_METRICS: &[(&str, &str, &str)] = &[
    ("ratio", "ratio", "alpha per token"),
    ("collateral", "alpha", "collateral"),
    ("supply", "count", "supply"),
];
const CHAIN_METRICS: &[(&str, &str, &str)] = &[
    ("chain_tx", "count", "tx per block"),
    ("events", "count", "frames per block"),
    ("combat", "count", "combat per block"),
    ("transfers", "count", "transfers per block"),
    ("raids", "count", "live raids"),
    ("structs", "count", "structs"),
    ("draw", "power", "galaxy draw"),
    ("proofs", "count", "proofs per block"),
];

#[tauri::command]
pub fn terminal_chart_catalog() -> Value {
    let stat: Vec<Value> = STAT_METRICS
        .iter()
        .map(|(m, unit, types)| json!({ "metric": m, "unit": unit, "object_types": types }))
        .collect();
    let galaxy: Vec<Value> = STAT_METRICS
        .iter()
        .map(|(m, unit, types)| json!({ "metric": m, "unit": unit, "object_types": types }))
        .collect();
    let list = |t: &[(&str, &str, &str)]| -> Vec<Value> {
        t.iter().map(|(m, u, l)| json!({ "metric": m, "unit": u, "label": l })).collect()
    };
    let providers: Vec<String> = lock(&MARKET).providers.keys().cloned().collect();
    json!({
        "sources": [
            { "source": "stat", "label": "an object", "subject": "id", "metrics": stat },
            { "source": "galaxy", "label": "every object of a type", "subject": "object_type", "metrics": galaxy },
            { "source": "bank", "label": "a guild token", "subject": "guild", "metrics": list(BANK_METRICS) },
            { "source": "market", "label": "the energy market", "subject": null, "metrics": list(MARKET_METRICS) },
            { "source": "provider", "label": "one provider", "subject": "provider", "metrics": list(PROVIDER_METRICS), "known": providers },
            { "source": "chain", "label": "the last hour, by block", "subject": null, "metrics": list(CHAIN_METRICS) },
        ],
        "windows": [21600, 86400, 604800, 2592000],
        "market_samples": lock(&MARKET).samples.len(),
    })
}

// ── One grid, many series ────────────────────────────────────────────────────

#[derive(Deserialize, Clone, Debug)]
pub struct SeriesReq {
    pub source: String,
    pub metric: String,
    #[serde(default)]
    pub subject: Option<String>,
}

fn unit_of(table: &'static [(&'static str, &'static str, &'static str)], metric: &str) -> Option<(&'static str, &'static str)> {
    table.iter().find(|(m, _, _)| *m == metric).map(|(_, u, l)| (*u, *l))
}

/// `(ts_ms, value)` samples from a ring of `{ts_ms, <key>}` rows.
fn ring_samples(rows: &[Value], key: &str) -> Vec<(f64, f64)> {
    rows.iter()
        .filter_map(|r| {
            let t = r.get("ts_ms")?.as_f64()?;
            let v = parse_num(r.get(key))?;
            Some((t, v))
        })
        .collect()
}

async fn fetch_one(req: &SeriesReq, start_s: u64, end_s: u64, window_s: u64) -> Result<(Vec<(f64, f64)>, String, String), String> {
    let client = crate::mcp::cosmos_client::CosmosClient::new();
    match req.source.as_str() {
        "stat" => {
            let subject = req.subject.clone().unwrap_or_default();
            let Some((_, unit, types)) = STAT_METRICS.iter().find(|(m, _, _)| *m == req.metric) else {
                return Err(format!("unknown metric {}", req.metric));
            };
            let Some(otype) = object_type_of(&subject) else {
                return Err(format!("{subject} is not an object id"));
            };
            if !types.contains(&otype) {
                return Err(format!("{} is not recorded for a {otype}", req.metric));
            }
            let (bucket, _) = stat_bucket_for(window_s);
            let rows = client.guild.stat_range(&req.metric, &subject, start_s, end_s, bucket, 1000).await?;
            let samples = rows
                .iter()
                .filter_map(|r| {
                    let t = r.get("time").and_then(|v| v.as_str()).and_then(crate::mcp::raid_view::parse_guild_time)?;
                    Some((t, parse_num(r.get("value"))?))
                })
                .collect();
            Ok((samples, unit.to_string(), format!("{} · {}", req.metric.replace('_', " "), subject)))
        }
        "galaxy" => {
            let otype = req.subject.clone().unwrap_or_default();
            let Some((_, unit, types)) = STAT_METRICS.iter().find(|(m, _, _)| *m == req.metric) else {
                return Err(format!("unknown metric {}", req.metric));
            };
            if !types.contains(&otype.as_str()) {
                return Err(format!("{} is not recorded for a {otype}", req.metric));
            }
            let bucket = if window_s <= 172_800 { "1h" } else { "1d" };
            let rows = client.guild.stat_aggregate(&req.metric, &otype, bucket, start_s as i64, end_s as i64).await?;
            let samples = rows
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(|r| {
                            let t = r.get("bucket").and_then(|v| v.as_str()).and_then(crate::mcp::raid_view::parse_guild_time)?;
                            Some((t, parse_num(r.get("sum"))?))
                        })
                        .collect()
                })
                .unwrap_or_default();
            Ok((samples, unit.to_string(), format!("all {otype} {}", req.metric.replace('_', " "))))
        }
        "bank" => {
            let gid = req.subject.clone().unwrap_or_default();
            let Some((unit, label)) = unit_of(BANK_METRICS, &req.metric) else {
                return Err(format!("unknown bank metric {}", req.metric));
            };
            let banks = crate::mcp::terminal::terminal_guild_banks().await?;
            let rows = banks.get("history").and_then(|h| h.get(&gid)).and_then(|v| v.as_array()).cloned().unwrap_or_default();
            Ok((ring_samples(&rows, &req.metric), unit.to_string(), format!("{gid} {label}")))
        }
        "market" => {
            let Some((unit, label)) = unit_of(MARKET_METRICS, &req.metric) else {
                return Err(format!("unknown market metric {}", req.metric));
            };
            let rows = lock(&MARKET).samples.clone();
            Ok((ring_samples(&rows, &req.metric), unit.to_string(), format!("market {label}")))
        }
        "provider" => {
            let pid = req.subject.clone().unwrap_or_default();
            let Some((unit, label)) = unit_of(PROVIDER_METRICS, &req.metric) else {
                return Err(format!("unknown provider metric {}", req.metric));
            };
            let rows = lock(&MARKET).providers.get(&pid).cloned().unwrap_or_default();
            Ok((ring_samples(&rows, &req.metric), unit.to_string(), format!("{pid} {label}")))
        }
        "chain" => {
            let Some((unit, label)) = unit_of(CHAIN_METRICS, &req.metric) else {
                return Err(format!("unknown chain metric {}", req.metric));
            };
            let snap = crate::mcp::game_stats::snapshot();
            let height = snap.get("block_height").and_then(|v| v.as_f64()).unwrap_or(0.0);
            let now = crate::hasher::types::now_millis();
            let rows = snap.get("series").and_then(|v| v.as_array()).cloned().unwrap_or_default();
            // Blocks are ~5.3 s apart; a point's time is its distance from now.
            let samples = rows
                .iter()
                .filter_map(|r| {
                    let h = r.get("height")?.as_f64()?;
                    let v = parse_num(r.get(req.metric.as_str()))?;
                    Some((now - (height - h).max(0.0) * 5300.0, v))
                })
                .collect();
            Ok((samples, unit.to_string(), label.to_string()))
        }
        other => Err(format!("unknown source {other}")),
    }
}

/// Every series of a chart, on one grid. A series that fails answers with
/// `error` and no values; the others still draw.
#[tauri::command]
pub async fn terminal_chart_series(series: Vec<SeriesReq>, window_s: u64, points: Option<u32>) -> Result<Value, String> {
    if series.is_empty() {
        return Err("a chart needs at least one series".into());
    }
    if series.len() > 8 {
        return Err("eight series is the most one chart can hold".into());
    }
    let window_s = window_s.clamp(60, 2_592_000);
    let points = points.unwrap_or(120).clamp(8, 600) as usize;
    let end_s = (crate::hasher::types::now_millis() / 1000.0) as u64;
    let start_s = end_s.saturating_sub(window_s);
    let start_ms = start_s as f64 * 1000.0;
    let step_ms = (window_s as f64 * 1000.0) / points as f64;

    let futs = series.iter().map(|req| fetch_one(req, start_s, end_s, window_s));
    let results: Vec<Result<(Vec<(f64, f64)>, String, String), String>> = futures_util::future::join_all(futs).await;
    let out: Vec<Value> = series
        .iter()
        .zip(results)
        .map(|(req, res)| match res {
            Ok((mut samples, unit, label)) => {
                samples.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
                let values = locf(&samples, start_ms, step_ms, points);
                json!({
                    "source": req.source, "metric": req.metric, "subject": req.subject,
                    "unit": unit, "label": label,
                    "samples": samples.len(),
                    "first_ms": samples.first().map(|s| s.0),
                    "last": samples.last().map(|s| s.1),
                    "values": values,
                })
            }
            Err(e) => json!({ "source": req.source, "metric": req.metric, "subject": req.subject, "error": e, "values": [] }),
        })
        .collect();
    Ok(json!({
        "start_ms": start_ms, "end_ms": start_ms + window_s as f64 * 1000.0, "step_ms": step_ms,
        "points": points, "window_s": window_s, "series": out,
    }))
}

// ── Saved charts ─────────────────────────────────────────────────────────────

const CHARTS_FILE: &str = "terminal-charts.json";

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct ChartsStore {
    #[serde(default)]
    pub charts: BTreeMap<String, Value>,
}
static CHARTS: LazyLock<Mutex<ChartsStore>> =
    LazyLock::new(|| Mutex::new(crate::mcp::config_store::load_config(CHARTS_FILE)));

/// A chart's name: letters, digits, space, dash, underscore; forty at most.
fn sane_name(s: &str) -> Option<String> {
    let t: String = s.trim().chars().filter(|c| c.is_alphanumeric() || *c == ' ' || *c == '-' || *c == '_').collect();
    let t = t.trim().to_string();
    if t.is_empty() || t.chars().count() > 40 { None } else { Some(t) }
}
/// A ⌘K word: letters and digits, upper-cased, twelve at most.
fn sane_word(s: &str) -> Option<String> {
    let t: String = s.trim().chars().filter(|c| c.is_ascii_alphanumeric()).collect::<String>().to_ascii_uppercase();
    if t.is_empty() || t.len() > 12 { None } else { Some(t) }
}

fn charts_list(st: &ChartsStore) -> Value {
    Value::Array(
        st.charts
            .iter()
            .map(|(name, def)| {
                let mut d = def.clone();
                if let Some(o) = d.as_object_mut() {
                    o.insert("name".into(), json!(name));
                }
                d
            })
            .collect(),
    )
}

#[tauri::command]
pub fn terminal_charts() -> Value {
    charts_list(&lock(&CHARTS))
}

/// Save (or replace) a chart by name. `word` is the optional ⌘K word; a word
/// another chart already owns is refused rather than silently stolen.
#[tauri::command]
pub fn terminal_chart_save(name: String, params: Value, word: Option<String>) -> Result<Value, String> {
    let name = sane_name(&name).ok_or("a chart needs a name — letters, digits, spaces")?;
    let word = match word.as_deref().map(str::trim).filter(|w| !w.is_empty()) {
        Some(w) => Some(sane_word(w).ok_or("a ⌘K word is letters and digits, twelve at most")?),
        None => None,
    };
    if !params.is_object() {
        return Err("a chart is its params".into());
    }
    let mut st = lock(&CHARTS);
    if let Some(w) = &word {
        if let Some((other, _)) = st.charts.iter().find(|(n, d)| *n != &name && d.get("word").and_then(|v| v.as_str()) == Some(w.as_str())) {
            return Err(format!("{w} already opens \"{other}\""));
        }
    }
    let saved_ms = crate::hasher::types::now_millis();
    st.charts.insert(name.clone(), json!({ "params": params, "word": word, "saved_ms": saved_ms }));
    crate::mcp::config_store::save_config(CHARTS_FILE, &*st);
    Ok(json!({ "ok": true, "name": name, "word": word, "charts": charts_list(&st) }))
}

#[tauri::command]
pub fn terminal_chart_delete(name: String) -> Result<Value, String> {
    let mut st = lock(&CHARTS);
    if st.charts.remove(name.trim()).is_none() {
        return Err(format!("no chart called \"{}\"", name.trim()));
    }
    crate::mcp::config_store::save_config(CHARTS_FILE, &*st);
    Ok(json!({ "ok": true, "charts": charts_list(&st) }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_and_words_are_sane() {
        assert_eq!(sane_name("  OH token vs market  ").as_deref(), Some("OH token vs market"));
        assert_eq!(sane_name("<script>"), Some("script".into()));
        assert_eq!(sane_name(""), None);
        assert_eq!(sane_word("ohm").as_deref(), Some("OHM"));
        assert_eq!(sane_word("o h m!").as_deref(), Some("OHM"));
        assert_eq!(sane_word("toolongforawordhere"), None);
    }

    #[test]
    fn ring_samples_skip_what_is_not_a_number() {
        let rows = vec![
            json!({ "ts_ms": 1000.0, "best": 2.5 }),
            json!({ "ts_ms": 2000.0, "best": null }),
            json!({ "ts_ms": 3000.0, "best": "3.5" }),
            json!({ "best": 9.0 }),
        ];
        assert_eq!(ring_samples(&rows, "best"), vec![(1000.0, 2.5), (3000.0, 3.5)]);
    }

    #[test]
    fn the_catalogue_names_every_source() {
        let c = terminal_chart_catalog();
        let sources: Vec<&str> = c["sources"].as_array().unwrap().iter().map(|s| s["source"].as_str().unwrap()).collect();
        assert_eq!(sources, vec!["stat", "galaxy", "bank", "market", "provider", "chain"]);
        assert_eq!(c["sources"][0]["metrics"].as_array().unwrap().len(), STAT_METRICS.len());
        assert!(c["sources"][3]["metrics"].as_array().unwrap().iter().any(|m| m["metric"] == "best"));
    }

    #[test]
    fn a_market_reading_becomes_samples_at_most_every_five_minutes() {
        let m = json!({
            "best_alpha_per_kw_day": 2.0, "median_alpha_per_kw_day": 3.0, "open_capacity_mw": 12.5, "priced": 4,
            "providers": [
                { "id": "10-4", "alpha_per_kw_day": 2.0, "provider": { "capacity_max": 5000.0, "capacity_used": 1500.0 } },
                { "id": "10-5", "alpha_per_kw_day": null, "provider": { "capacity_max": 800.0 } }
            ]
        });
        {
            let mut r = lock(&MARKET);
            r.samples.clear();
            r.providers.clear();
        }
        note_market(&m);
        note_market(&m); // inside the gap: ignored
        let r = lock(&MARKET);
        assert_eq!(r.samples.len(), 1);
        assert_eq!(r.samples[0]["offers"], 2);
        assert_eq!(r.samples[0]["best"], 2.0);
        assert_eq!(r.providers["10-4"][0]["free_w"], 3500.0);
        assert!(r.providers["10-5"][0]["rate"].is_null());
    }
}
