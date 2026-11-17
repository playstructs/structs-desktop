//! Sector Blitz, live: the influence GRASS stream turned into a tape.
//!
//! The guild's relay publishes every influence frame on
//! `structs.influence.<chain>.<contest>.<scope>` as fixed 4 KiB base64 parts
//! (`category: "influence_part"`, structs-grass `influence.go`). The native
//! subscriber already hears them (`structs.>`); `grass_native::ingest_resolving`
//! hands each part here instead of to the general event pipeline, because a
//! part is transport, not a game event.
//!
//! Three steps, the same rules as the webapp's `InfluenceStream.js`
//! (contract: structs-pg `docs/influence-grass-20261111.md`):
//!
//! 1. ASSEMBLE — parts keyed by subject + frame id; a frame is complete when
//!    every index has arrived, and is accepted only if its SHA-256 matches and
//!    its envelope names the same contract, subject and frame id.
//! 2. STORE — per subject: an older build or an already-seen frame id is
//!    ignored; a patch whose `previous_frame_id` is not the last one seen is a
//!    GAP (counted, and its state still applied: every frame is complete).
//! 3. DIFF — consecutive planet frames of one build become planet-level events
//!    (a raid's win credited, a claim taken or cleared, coverage moving with a
//!    member); consecutive scores frames become sector lead changes. A
//!    replace frame, or a first sight of a scope, is a new baseline and says
//!    nothing — except a planet whose latest raid happened AT this frame's
//!    height, which is the raid that produced it.
//!
//! READ ONLY: nothing here publishes, requests or signs.

use base64::Engine;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::sync::{LazyLock, Mutex};

pub const CONTRACT: &str = "structs-influence-grass-v1";
pub const PART_CATEGORY: &str = "influence_part";
const PART_BYTES: usize = 4096;
/// base64 of 4096 bytes is 5464 characters.
const PART_B64: usize = 5464;
const MAX_PENDING: usize = 1024;
const MAX_PENDING_BYTES: usize = 64 * 1024 * 1024;
/// A frame whose parts stop arriving is dropped after this long.
const PENDING_TTL_MS: u64 = 120_000;
const MAX_SCOPES: usize = 50_000;
const RING: usize = 1000;

#[derive(Default)]
struct Pending {
    count: usize,
    digest: String,
    parts: BTreeMap<usize, Vec<u8>>,
    bytes: usize,
    first_ms: u64,
}

#[derive(Clone)]
struct Scope {
    frame_id: u64,
    build_id: u64,
    data: Value,
}

#[derive(Default, Clone)]
struct ContestSeen {
    frames: u64,
    last_frame_ms: u64,
    last_height: u64,
    build_id: u64,
    status: Option<String>,
}

/// Everything the stream knows. One instance behind a lock; pure methods so
/// the tests drive it without an app.
#[derive(Default)]
pub struct Stream {
    pending: HashMap<(String, String), Pending>,
    pending_bytes: usize,
    scopes: HashMap<String, Scope>,
    contests: HashMap<String, ContestSeen>,
    ring: VecDeque<Value>,
    seq: u64,
    pub parts: u64,
    pub frames: u64,
    pub gaps: u64,
    pub rejected: u64,
    pub expired: u64,
}

fn dec(v: Option<&Value>) -> Option<u64> {
    match v? {
        Value::String(s) if !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()) => s.parse().ok(),
        Value::Number(n) => n.as_u64(),
        _ => None,
    }
}
fn s<'a>(v: &'a Value, k: &str) -> Option<&'a str> {
    v.get(k).and_then(|x| x.as_str()).filter(|x| !x.is_empty())
}

impl Stream {
    /// One part. Answers the events the completed frame produced (usually
    /// none: most parts complete nothing, most frames change nothing).
    pub fn accept_part(&mut self, subject: &str, part: &Value, now: u64) -> Result<Vec<Value>, String> {
        self.parts += 1;
        self.expire(now);
        if part.get("contract").and_then(|v| v.as_str()) != Some(CONTRACT) {
            return Err("not an influence part".into());
        }
        let frame_id = s(part, "frame_id").filter(|f| f.bytes().all(|b| b.is_ascii_digit())).ok_or("bad frame_id")?.to_string();
        let index = part.get("part_index").and_then(|v| v.as_u64()).ok_or("bad part_index")? as usize;
        let count = part.get("part_count").and_then(|v| v.as_u64()).ok_or("bad part_count")? as usize;
        let digest = s(part, "sha256").filter(|d| d.len() == 64 && d.bytes().all(|b| b.is_ascii_hexdigit())).ok_or("bad sha256")?.to_ascii_lowercase();
        let b64 = s(part, "payload").ok_or("no payload")?;
        if count == 0 || count > MAX_PENDING_BYTES / PART_BYTES || index >= count
            || part.get("encoding").and_then(|v| v.as_str()) != Some("base64") || b64.len() > PART_B64 {
            return Err("invalid influence part".into());
        }
        let bytes = base64::engine::general_purpose::STANDARD.decode(b64).map_err(|e| format!("part base64: {e}"))?;
        if bytes.len() > PART_BYTES {
            return Err("oversized influence part".into());
        }
        let key = (subject.to_string(), frame_id.clone());
        if !self.pending.contains_key(&key) && self.pending.len() >= MAX_PENDING {
            return Err("too many incomplete influence frames".into());
        }
        let entry = self.pending.entry(key.clone()).or_insert_with(|| Pending { count, digest: digest.clone(), first_ms: now, ..Default::default() });
        if entry.count != count || entry.digest != digest {
            return Err("conflicting influence parts".into());
        }
        if let Some(have) = entry.parts.get(&index) {
            if *have != bytes {
                return Err("conflicting influence part".into());
            }
        } else {
            if self.pending_bytes + bytes.len() > MAX_PENDING_BYTES {
                return Err("influence assembly memory limit".into());
            }
            self.pending_bytes += bytes.len();
            entry.bytes += bytes.len();
            entry.parts.insert(index, bytes);
        }
        if entry.parts.len() < entry.count {
            return Ok(vec![]);
        }
        let done = self.pending.remove(&key).unwrap_or_default();
        self.pending_bytes = self.pending_bytes.saturating_sub(done.bytes);
        let mut body = Vec::with_capacity(done.bytes);
        for (_, chunk) in done.parts {
            body.extend_from_slice(&chunk);
        }
        if hex::encode(Sha256::digest(&body)) != done.digest {
            return Err("influence digest mismatch".into());
        }
        let frame: Value = serde_json::from_slice(&body).map_err(|e| format!("influence frame json: {e}"))?;
        if frame.get("contract").and_then(|v| v.as_str()) != Some(CONTRACT)
            || s(&frame, "subject") != Some(subject)
            || s(&frame, "frame_id") != Some(frame_id.as_str())
        {
            return Err("influence envelope mismatch".into());
        }
        self.apply(frame, now)
    }

    fn expire(&mut self, now: u64) {
        let old: Vec<_> = self.pending.iter().filter(|(_, p)| now.saturating_sub(p.first_ms) > PENDING_TTL_MS).map(|(k, _)| k.clone()).collect();
        for k in old {
            if let Some(p) = self.pending.remove(&k) {
                self.pending_bytes = self.pending_bytes.saturating_sub(p.bytes);
                self.expired += 1;
            }
        }
    }

    /// One complete frame into the store; the events its change produced.
    pub fn apply(&mut self, frame: Value, now: u64) -> Result<Vec<Value>, String> {
        let subject = s(&frame, "subject").ok_or("frame has no subject")?.to_string();
        let frame_id = dec(frame.get("frame_id")).ok_or("bad frame_id")?;
        let previous = dec(frame.get("previous_frame_id")).ok_or("bad previous_frame_id")?;
        let build = dec(frame.get("build_id")).ok_or("bad build_id")?;
        let height = dec(frame.get("height")).ok_or("bad height")?;
        let mode = s(&frame, "mode").ok_or("no mode")?;
        if mode != "patch" && mode != "replace" {
            return Err("bad mode".into());
        }
        let category = s(&frame, "category").unwrap_or("").to_string();
        self.frames += 1;
        let contest = s(&frame, "contest_id").unwrap_or("").to_string();
        let ctx = frame.get("context").cloned().unwrap_or(Value::Null);
        {
            let c = self.contests.entry(contest.clone()).or_default();
            c.frames += 1;
            c.last_frame_ms = now;
            c.last_height = c.last_height.max(height);
            c.build_id = c.build_id.max(build);
            if let Some(st) = s(&ctx, "status") {
                c.status = Some(st.to_string());
            }
        }
        // History segments carry a graph, not state; the tape has no use for them.
        if category == "influence_history" {
            return Ok(vec![]);
        }
        let old = self.scopes.get(&subject).cloned();
        if let Some(o) = &old {
            if build < o.build_id || frame_id <= o.frame_id {
                return Ok(vec![]);
            }
            if mode == "patch" && o.build_id == build && previous != o.frame_id {
                self.gaps += 1;
            }
        }
        let data = frame.get("data").cloned().unwrap_or(Value::Null);
        let same_build = old.as_ref().map(|o| o.build_id == build).unwrap_or(false);
        let prior = if mode == "patch" && same_build { old.as_ref().map(|o| &o.data) } else { None };
        let events = if mode != "patch" {
            vec![]
        } else {
            match category.as_str() {
                "influence_planet" => planet_events(prior, &data, height, &ctx),
                "influence_scores" => match prior {
                    Some(p) => lead_events(p.get("standings"), data.get("standings")),
                    None => vec![],
                },
                _ => vec![],
            }
        };
        // Only the scopes a diff needs are kept; guild and player frames are
        // counted and let go.
        if (category == "influence_planet" || category == "influence_scores")
            && (self.scopes.len() < MAX_SCOPES || self.scopes.contains_key(&subject))
        {
            let keep = if category == "influence_scores" { json!({ "standings": data.get("standings").cloned().unwrap_or(Value::Null) }) } else { data };
            self.scopes.insert(subject, Scope { frame_id, build_id: build, data: keep });
        }
        let chain = s(&frame, "chain_id").unwrap_or("").to_string();
        let mut out = Vec::new();
        for mut e in events {
            self.seq += 1;
            if let Some(o) = e.as_object_mut() {
                o.insert("seq".into(), json!(self.seq));
                o.insert("contest_id".into(), json!(contest));
                o.insert("chain_id".into(), json!(chain));
                o.insert("build_id".into(), json!(build.to_string()));
                o.insert("height".into(), json!(height.to_string()));
                o.insert("at_ms".into(), json!(now));
            }
            if self.ring.len() >= RING {
                self.ring.pop_front();
            }
            self.ring.push_back(e.clone());
            out.push(e);
        }
        Ok(out)
    }

    /// The tape for one contest: events after `since`, newest first.
    pub fn tape(&self, contest: &str, since: u64, limit: usize) -> Vec<Value> {
        self.ring
            .iter()
            .rev()
            .filter(|e| e.get("contest_id").and_then(|v| v.as_str()) == Some(contest))
            .filter(|e| e.get("seq").and_then(|v| v.as_u64()).unwrap_or(0) > since)
            .take(limit)
            .cloned()
            .collect()
    }

    pub fn status(&self, contest: &str) -> Value {
        let c = self.contests.get(contest).cloned().unwrap_or_default();
        json!({
            "frames": c.frames, "last_frame_ms": c.last_frame_ms, "last_height": c.last_height.to_string(),
            "build_id": c.build_id.to_string(), "status": c.status,
            "all_frames": self.frames, "parts": self.parts, "gaps": self.gaps, "rejected": self.rejected,
            "expired": self.expired, "pending": self.pending.len(), "seq": self.seq,
        })
    }
}

fn coverage(p: Option<&Value>) -> Vec<String> {
    p.and_then(|p| p.get("guild_coverage")).and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|c| c.get("guild_id").and_then(|g| g.as_str()).map(String::from)).collect())
        .unwrap_or_default()
}

/// A planet's change between two frames, as tape events.
///
/// With no prior state (first sight, or the first frame after a rebuild) the
/// only thing knowable is a raid that happened AT this frame's height — the
/// frame exists because of it. Its credit is then unknown (`credited: null`):
/// a guild already on the coverage list may have been there before.
pub fn planet_events(prior: Option<&Value>, now: &Value, height: u64, ctx: &Value) -> Vec<Value> {
    let win = dec(ctx.get("win_points")).unwrap_or(0) as i64;
    let claim = dec(ctx.get("claim_points")).unwrap_or(0) as i64;
    let raid = now.get("latest_raid").filter(|r| !r.is_null());
    let raid_id = raid.and_then(|r| s(r, "raid_id"));
    let fresh_raid = match prior {
        Some(p) => raid_id.is_some() && raid_id != p.get("latest_raid").and_then(|r| s(r, "raid_id")),
        None => raid.and_then(|r| dec(r.get("height"))) == Some(height),
    };
    let new_cov = coverage(Some(now));
    let old_cov = coverage(prior);
    let (credited, uncredited): (Option<Vec<String>>, Vec<String>) = match prior {
        Some(_) => (
            Some(new_cov.iter().filter(|g| !old_cov.contains(g)).cloned().collect()),
            old_cov.iter().filter(|g| !new_cov.contains(g)).cloned().collect(),
        ),
        None => (None, vec![]),
    };
    let holder = |p: Option<&Value>| p.and_then(|p| s(p, "holder")).map(String::from);
    let hguild = |p: Option<&Value>| p.and_then(|p| s(p, "holder_guild_id")).map(String::from);
    let (h0, h1, g0, g1) = (holder(prior), holder(Some(now)), hguild(prior), hguild(Some(now)));
    let claim_moved = prior.is_some() && (h0 != h1 || g0 != g1);
    let changed = fresh_raid || claim_moved || credited.as_ref().map(|c| !c.is_empty()).unwrap_or(false) || !uncredited.is_empty();
    if !changed {
        return vec![];
    }
    // Who gains what, by guild: the unique bonus for each newly credited
    // guild, the claim moving from the old holder's guild to the new one's.
    let mut gains: BTreeMap<String, i64> = BTreeMap::new();
    for g in credited.iter().flatten() { *gains.entry(g.clone()).or_default() += win; }
    for g in &uncredited { *gains.entry(g.clone()).or_default() -= win; }
    if prior.is_some() && g0 != g1 {
        if let Some(g) = &g0 { *gains.entry(g.clone()).or_default() -= claim; }
        if let Some(g) = &g1 { *gains.entry(g.clone()).or_default() += claim; }
    }
    let kind = if fresh_raid { "raid" } else if h0 != h1 { "claim" } else { "transfer" };
    vec![json!({
        "kind": kind,
        "planet_id": now.get("planet_id").cloned().unwrap_or(Value::Null),
        "sector": now.get("sector").cloned().unwrap_or(Value::Null),
        "raid": if fresh_raid { raid.cloned().unwrap_or(Value::Null) } else { Value::Null },
        "credited": credited,
        "uncredited": uncredited,
        "holder_before": h0, "holder_after": h1,
        "holder_guild_before": g0, "holder_guild_after": g1,
        "claim_known": prior.is_some(),
        "gains": gains.into_iter().filter(|(_, v)| *v != 0).map(|(g, v)| json!({ "guild_id": g, "points": v })).collect::<Vec<_>>(),
    })]
}

/// Each sector's leaders (ties share; zero never leads).
fn leaders(standings: Option<&Value>) -> BTreeMap<i64, (Vec<String>, i64)> {
    let mut by: BTreeMap<i64, (Vec<String>, i64)> = BTreeMap::new();
    for r in standings.and_then(|v| v.as_array()).into_iter().flatten() {
        let sector = r.get("sector").and_then(|v| v.as_i64()).unwrap_or(0);
        let pts = dec(r.get("points")).unwrap_or(0) as i64;
        let g = match s(r, "guild_id") { Some(g) => g.to_string(), None => continue };
        let e = by.entry(sector).or_insert((vec![], 0));
        if pts > e.1 { *e = (vec![g], pts); } else if pts == e.1 && pts > 0 { e.0.push(g); }
    }
    for e in by.values_mut() { e.0.sort(); if e.1 == 0 { e.0.clear(); } }
    by
}

/// Sector lead changes between two scoreboards.
pub fn lead_events(before: Option<&Value>, after: Option<&Value>) -> Vec<Value> {
    let (a, b) = (leaders(before), leaders(after));
    let sectors: HashSet<i64> = a.keys().chain(b.keys()).copied().collect();
    let mut sectors: Vec<i64> = sectors.into_iter().collect();
    sectors.sort();
    sectors.into_iter().filter_map(|sec| {
        let was = a.get(&sec).map(|x| x.0.clone()).unwrap_or_default();
        let (now, pts) = b.get(&sec).cloned().unwrap_or_default();
        (now != was && !now.is_empty()).then(|| json!({ "kind": "lead", "sector": sec, "leaders": now, "before": was, "points": pts.to_string() }))
    }).collect()
}

static STREAM: LazyLock<Mutex<Stream>> = LazyLock::new(|| Mutex::new(Stream::default()));

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// An `influence_part` GRASS event (from either GRASS source). Complete
/// frames that changed something are announced to the board family as
/// `influence-tape`.
pub fn accept(app: &tauri::AppHandle, subject: &str, part: &Value) {
    let result = {
        let mut st = STREAM.lock().unwrap_or_else(|p| p.into_inner());
        let r = st.accept_part(subject, part, now_ms());
        if r.is_err() { st.rejected += 1; }
        r
    };
    match result {
        Ok(events) if !events.is_empty() => {
            let contest = events[0].get("contest_id").cloned().unwrap_or(Value::Null);
            let _ = crate::mcp::events::emit(app, crate::mcp::events::AppEvent::Board {
                name: "influence-tape",
                payload: json!({ "contest_id": contest, "events": events }),
            });
        }
        Ok(_) => {}
        Err(e) => crate::mcp::telemetry::tlog("influence", crate::mcp::telemetry::Sev::Warn, format!("{subject}: {e}")),
    }
}

/// The live tape for one contest, newest first, after `since` (a `seq`).
/// `live` is whether the stream can be trusted to be complete right now:
/// frames for this contest have been heard, and GRASS is connected.
#[tauri::command]
pub fn terminal_influence_tape(contest: u64, since: Option<u64>, limit: Option<u32>) -> Value {
    let key = contest.to_string();
    let st = STREAM.lock().unwrap_or_else(|p| p.into_inner());
    let status = st.status(&key);
    let heard = status.get("frames").and_then(|v| v.as_u64()).unwrap_or(0) > 0;
    let connected = crate::mcp::grass_native::authoritative();
    json!({
        "events": st.tape(&key, since.unwrap_or(0), limit.unwrap_or(200).clamp(1, 1000) as usize),
        "live": heard && connected,
        "connected": connected,
        "status": status,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(subject: &str, id: u64, prev: u64, build: u64, h: u64, mode: &str, cat: &str, data: Value) -> Value {
        json!({ "contract": CONTRACT, "subject": subject, "category": cat, "frame_id": id.to_string(), "previous_frame_id": prev.to_string(),
            "mode": mode, "contest_id": "2", "chain_id": "c", "build_id": build.to_string(), "height": h.to_string(),
            "context": { "win_points": "100", "claim_points": "200", "status": "active" }, "data": data })
    }
    /// The relay's own encoding (structs-grass influence.go `influenceParts`).
    fn parts(subject: &str, f: &Value) -> Vec<Value> {
        let body = serde_json::to_vec(f).unwrap();
        let sum = hex::encode(Sha256::digest(&body));
        let n = body.len().div_ceil(PART_BYTES);
        (0..n).map(|i| json!({ "contract": CONTRACT, "subject": subject, "category": PART_CATEGORY, "frame_id": f["frame_id"],
            "part_index": i, "part_count": n, "sha256": sum, "encoding": "base64",
            "payload": base64::engine::general_purpose::STANDARD.encode(&body[i * PART_BYTES..((i + 1) * PART_BYTES).min(body.len())]) })).collect()
    }
    fn planet(holder: Option<&str>, hg: Option<&str>, raid: Option<(&str, u64, &str, &str)>, cov: &[&str]) -> Value {
        json!({ "planet_id": "2-41", "exists": true, "sector": 127, "holder": holder, "holder_guild_id": hg,
            "latest_raid": raid.map(|(id, h, a, ag)| json!({ "raid_id": id, "height": h.to_string(), "attacker": a, "defender": "1-80", "attacker_guild": ag, "defender_guild": "0-3", "source_sector": 127 })),
            "guild_coverage": cov.iter().map(|g| json!({ "guild_id": g, "supporter_count": "1" })).collect::<Vec<_>>() })
    }
    const P: &str = "structs.influence.c.2.planet.2-41";

    #[test]
    fn multipart_frames_assemble_in_any_order_and_are_digest_checked() {
        let mut st = Stream::default();
        let big = frame(P, 10, 0, 1, 100, "replace", "influence_planet", json!({ "pad": "x".repeat(9000), "planet_id": "2-41" }));
        let mut ps = parts(P, &big);
        assert!(ps.len() >= 3);
        ps.reverse();
        for p in &ps[..ps.len() - 1] { assert!(st.accept_part(P, p, 0).unwrap().is_empty()); }
        st.accept_part(P, ps.last().unwrap(), 0).unwrap();
        assert_eq!(st.frames, 1, "the frame completed once every part arrived");
        // A tampered part never completes a frame.
        let mut st2 = Stream::default();
        let mut bad = parts(P, &big);
        bad[0]["sha256"] = json!("0".repeat(64));
        assert!(st2.accept_part(P, &bad[0], 0).is_ok());
        assert!(bad[1..].iter().any(|p| st2.accept_part(P, p, 0).is_err()));
        assert_eq!(st2.frames, 0);
    }

    #[test]
    fn a_raid_credits_a_guild_and_takes_the_claim() {
        let mut st = Stream::default();
        let a = planet(Some("1-12"), Some("0-2"), Some(("7", 90, "1-12", "0-2")), &["0-2"]);
        for p in parts(P, &frame(P, 10, 0, 1, 90, "replace", "influence_planet", a)) { st.accept_part(P, &p, 0).unwrap(); }
        let b = planet(Some("1-61"), Some("0-7"), Some(("8", 100, "1-61", "0-7")), &["0-2", "0-7"]);
        let mut ev = vec![];
        for p in parts(P, &frame(P, 11, 10, 1, 100, "patch", "influence_planet", b)) { ev = st.accept_part(P, &p, 5).unwrap(); }
        assert_eq!(ev.len(), 1);
        let e = &ev[0];
        assert_eq!(e["kind"], "raid");
        assert_eq!(e["credited"], json!(["0-7"]));
        assert_eq!(e["holder_guild_before"], "0-2");
        assert_eq!(e["holder_guild_after"], "0-7");
        assert_eq!(e["gains"], json!([{ "guild_id": "0-2", "points": -200 }, { "guild_id": "0-7", "points": 300 }]));
        assert_eq!(e["height"], "100");
        assert_eq!(st.tape("2", 0, 10).len(), 1);
        assert_eq!(st.tape("2", 1, 10).len(), 0, "since excludes what was read");
    }

    #[test]
    fn replays_old_builds_and_baselines_say_nothing_but_gaps_count() {
        let mut st = Stream::default();
        let a = planet(None, None, None, &[]);
        assert!(st.apply(frame(P, 10, 0, 2, 90, "replace", "influence_planet", a.clone()), 0).unwrap().is_empty());
        assert!(st.apply(frame(P, 10, 0, 2, 90, "replace", "influence_planet", a.clone()), 0).unwrap().is_empty(), "duplicate");
        let raided = planet(Some("1-61"), Some("0-7"), Some(("8", 100, "1-61", "0-7")), &["0-7"]);
        assert!(st.apply(frame(P, 20, 19, 1, 100, "patch", "influence_planet", raided.clone()), 0).unwrap().is_empty(), "older build ignored");
        let ev = st.apply(frame(P, 30, 25, 2, 100, "patch", "influence_planet", raided), 0).unwrap();
        assert_eq!(st.gaps, 1, "previous_frame_id 25 is not the 10 we saw");
        assert_eq!(ev.len(), 1, "the state is complete, so the change is still told");
        // A new build's replacement is a baseline, not a change.
        assert!(st.apply(frame(P, 40, 0, 3, 110, "replace", "influence_planet", planet(None, None, None, &[])), 0).unwrap().is_empty());
    }

    #[test]
    fn first_sight_tells_only_a_raid_at_this_height() {
        let ctx = json!({ "win_points": "100", "claim_points": "200" });
        let now = planet(Some("1-61"), Some("0-7"), Some(("8", 100, "1-61", "0-7")), &["0-7"]);
        let ev = planet_events(None, &now, 100, &ctx);
        assert_eq!(ev.len(), 1);
        assert!(ev[0]["credited"].is_null(), "credit is unknown without the prior state");
        assert_eq!(ev[0]["claim_known"], false);
        assert!(planet_events(None, &now, 105, &ctx).is_empty(), "an older raid is not news");
    }

    #[test]
    fn a_member_moving_guilds_moves_coverage_and_the_claim() {
        let ctx = json!({ "win_points": "100", "claim_points": "200" });
        let before = planet(Some("1-61"), Some("0-7"), Some(("8", 90, "1-61", "0-7")), &["0-7"]);
        let after = planet(Some("1-61"), Some("0-2"), Some(("8", 90, "1-61", "0-7")), &["0-2"]);
        let ev = planet_events(Some(&before), &after, 120, &ctx);
        assert_eq!(ev[0]["kind"], "transfer");
        assert_eq!(ev[0]["gains"], json!([{ "guild_id": "0-2", "points": 300 }, { "guild_id": "0-7", "points": -300 }]));
        assert!(planet_events(Some(&before), &before, 120, &ctx).is_empty(), "no change, no event");
    }

    #[test]
    fn lead_changes_come_from_consecutive_scoreboards() {
        let row = |g: &str, s: i64, p: &str| json!({ "guild_id": g, "sector": s, "points": p });
        let a = json!([row("0-7", 44, "300"), row("0-2", 44, "200"), row("0-7", 127, "0")]);
        let b = json!([row("0-7", 44, "300"), row("0-2", 44, "300"), row("0-2", 127, "100")]);
        let ev = lead_events(Some(&a), Some(&b));
        assert_eq!(ev.len(), 2);
        assert_eq!(ev[0]["sector"], 44);
        assert_eq!(ev[0]["leaders"], json!(["0-2", "0-7"]), "a tie shares the lead");
        assert_eq!(ev[1]["before"], json!([]));
        assert!(lead_events(Some(&a), Some(&a)).is_empty());
    }

    #[test]
    fn a_relay_part_off_the_wire_reaches_the_assembler_intact() {
        // NATS bytes → the same parse every GRASS message gets → this module.
        let f = frame(P, 10, 0, 1, 100, "patch", "influence_planet", planet(Some("1-61"), Some("0-7"), Some(("8", 100, "1-61", "0-7")), &["0-7"]));
        let wire = serde_json::to_vec(&parts(P, &f)[0]).unwrap();
        let ev = crate::mcp::grass_native::event_from_payload(P, &wire).expect("a part is a GRASS event");
        assert_eq!(ev.category, PART_CATEGORY);
        assert_eq!(ev.subject, P);
        let mut st = Stream::default();
        let out = st.accept_part(&ev.subject, &ev.detail, 0).unwrap();
        assert_eq!(st.frames, 1);
        assert_eq!(out.len(), 1, "a raid at the frame's own height is told on first sight");
    }

    #[test]
    fn stale_partial_frames_expire() {
        let mut st = Stream::default();
        let big = frame(P, 10, 0, 1, 100, "replace", "influence_planet", json!({ "pad": "x".repeat(9000) }));
        let ps = parts(P, &big);
        st.accept_part(P, &ps[0], 0).unwrap();
        assert_eq!(st.pending.len(), 1);
        st.accept_part("structs.influence.c.2.contest", &parts("structs.influence.c.2.contest", &frame("structs.influence.c.2.contest", 1, 0, 1, 1, "replace", "influence_contest", json!({})))[0], PENDING_TTL_MS + 1).unwrap();
        assert_eq!(st.pending.len(), 0);
        assert_eq!(st.expired, 1);
    }
}
