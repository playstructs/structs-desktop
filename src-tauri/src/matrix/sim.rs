//! Simulator challenges over chat.
//!
//! A battle is a code — `https://structs.app/sim/<battle>[/<result>]`, the
//! same link the simulator copies and the site unfurls (frontend/simcode.js,
//! structs-app/docs/links.md). In a room that link IS the challenge: it is
//! the body of the message, so Element, Discord and the site's preview all
//! keep working, and a `structs.sim` frame rides beside the body so this app
//! can read it without guessing — the same shape work frames had before the
//! bus (see `work.rs`).
//!
//! Three shapes are read, all strictly:
//!
//!   * the `structs.sim` key on an `m.room.message` (what this app sends);
//!   * a sim link in the body of any message — a link pasted from Discord is
//!     a challenge too, and must land on the same ladder;
//!   * `structs.sim` as its own event type, for live match frames that no
//!     person reads.
//!
//! Results are claims, not proofs: a battle is not replayable (the computer
//! decides on wall-clock timers). The ladder ranks what people say happened.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde_json::{json, Value};

/// The event type of a frame no person reads (live match traffic).
pub const EVENT_TYPE: &str = "structs.sim";
/// The key a frame rides under beside a message body.
pub const KEY: &str = "structs.sim";
/// The battle link's prefix — the site's, so the link unfurls everywhere.
pub const SITE: &str = "https://structs.app/sim/";
/// The simulator's combat rules + computer tuning. Results compare only
/// within one revision. Pinned to `RULES_REVISION` in frontend/simcode.js by
/// scripts/harness-tests/simchat.test.mjs.
pub const RULES_REVISION: u8 = 1;

const LEVELS: [&str; 3] = ["easy", "difficult", "hard"];
const BLOCK_MS: [u32; 2] = [2000, 6000];
const MAX_UNITS: usize = 34;
const MAX_CHARGE: u8 = 30;
/// How many people one challenge may be addressed to.
const MAX_TO: usize = 8;

fn b64url_char(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'-' || b == b'_'
}

/// A battle code's alphabet and size, before anything is decoded.
pub fn code_is_sound(code: &str) -> bool {
    (4..=2000).contains(&code.len()) && code.bytes().all(b64url_char)
}

/// A result code is always 19 bytes: 26 characters of base64url.
pub fn result_is_sound(code: &str) -> bool {
    code.len() == 26 && code.bytes().all(b64url_char)
}

fn bytes_of(code: &str) -> Option<Vec<u8>> {
    URL_SAFE_NO_PAD.decode(code.as_bytes()).ok()
}

/// What this side needs to know about a battle to write about it: not the
/// layout (the simulator's `validate()` judges that), only the header and
/// how many structs each side fields.
#[derive(Debug, Clone, PartialEq)]
pub struct Battle {
    pub difficulty: &'static str,
    pub block_ms: u32,
    pub charge: [u8; 2],
    pub seed: String,
    /// Structs fielded: [player, computer].
    pub units: [u32; 2],
}

/// The battle code's header, decoded exactly as simcode.js decodes it — and
/// refused for exactly what it refuses. A code that decodes there and not
/// here (or the reverse) would be a card here and a 404 there.
pub fn decode_battle(code: &str) -> Option<Battle> {
    if !code_is_sound(code) {
        return None;
    }
    let b = bytes_of(code)?;
    let mut i = 0usize;
    let mut next = || -> Option<u8> {
        let v = *b.get(i)?;
        i += 1;
        Some(v)
    };
    if next()? != 1 {
        return None;
    }
    let flags = next()?;
    let difficulty = *LEVELS.get((flags & 3) as usize)?;
    let block_ms = BLOCK_MS[((flags >> 2) & 1) as usize];
    let player = next()?;
    let computer = next()?;
    if player > MAX_CHARGE || computer > MAX_CHARGE {
        return None;
    }
    let n = next()?;
    if n > 60 {
        return None;
    }
    let mut seed = String::new();
    for _ in 0..n {
        let ch = next()?;
        if !(0x21..=0x7e).contains(&ch) {
            return None;
        }
        seed.push(ch as char);
    }
    let count = next()? as usize;
    if count > MAX_UNITS {
        return None;
    }
    let mut units = [0u32; 2];
    for _ in 0..count {
        let v = ((next()? as u16) << 8) | next()? as u16;
        let prot = (v & 63) as usize;
        if prot > count {
            return None;
        }
        units[(v >> 15) as usize] += 1;
    }
    if i != b.len() {
        return None;
    }
    Some(Battle { difficulty, block_ms, charge: [player, computer], seed, units })
}

/// How a battle went (spec: proposals/sim-results-link.md).
#[derive(Debug, Clone, PartialEq)]
pub struct Outcome {
    /// "player" | "computer" | "draw"
    pub winner: &'static str,
    pub forfeit: bool,
    pub stalemate: Option<&'static str>,
    pub revision: u8,
    pub blocks: u16,
    pub seconds: u16,
    /// [player, computer] × lost, attacks, damage, evaded, blocked, countered.
    pub stats: [[u8; 6]; 2],
}

pub fn decode_result(code: &str) -> Option<Outcome> {
    if !result_is_sound(code) {
        return None;
    }
    let b = bytes_of(code)?;
    if b.len() != 19 || b[0] != 1 || b[1] & 0xe0 != 0 {
        return None;
    }
    let winner = *["player", "computer", "draw"].get((b[1] & 3) as usize)?;
    let stalemate = match (b[1] >> 3) & 3 {
        0 => None,
        1 => Some("moves"),
        2 => Some("quiet"),
        _ => return None,
    };
    let forfeit = b[1] & 4 != 0;
    if forfeit && winner != "computer" {
        return None;
    }
    if stalemate.is_some() && winner != "draw" {
        return None;
    }
    let mut stats = [[0u8; 6]; 2];
    for (side, row) in stats.iter_mut().enumerate() {
        row.copy_from_slice(&b[7 + side * 6..13 + side * 6]);
    }
    Some(Outcome {
        winner,
        forfeit,
        stalemate,
        revision: b[2],
        blocks: u16::from_be_bytes([b[3], b[4]]),
        seconds: u16::from_be_bytes([b[5], b[6]]),
        stats,
    })
}

/// A result that claims more losses than its side fielded is not a result.
fn result_fits(b: &Battle, o: &Outcome) -> bool {
    (o.stats[0][0] as u32) <= b.units[0] && (o.stats[1][0] as u32) <= b.units[1]
}

/// A battle's name is its seed — "spearpoint" → "Spearpoint".
pub fn name_of(b: &Battle) -> String {
    let mut c = b.seed.chars();
    match c.next() {
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
        None => "Battle".to_string(),
    }
}

fn cap(s: &str) -> String {
    let mut c = s.chars();
    match c.next() {
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
        None => String::new(),
    }
}

/// `mm:ss`, or `h:mm:ss` past an hour — the debrief's own clock.
pub fn clock(seconds: u16) -> String {
    let s = seconds as u32;
    if s >= 3600 {
        format!("{}:{:02}:{:02}", s / 3600, (s / 60) % 60, s % 60)
    } else {
        format!("{:02}:{:02}", s / 60, s % 60)
    }
}

pub fn verdict(o: &Outcome) -> &'static str {
    match (o.winner, o.forfeit) {
        ("player", _) => "Victory",
        ("draw", _) => "Draw",
        (_, true) => "Forfeit",
        _ => "Defeat",
    }
}

pub fn link(battle: &str, result: Option<&str>) -> String {
    match result {
        Some(r) => format!("{SITE}{battle}/{r}"),
        None => format!("{SITE}{battle}"),
    }
}

/// "Spearpoint · Difficult · 9 v 9"
pub fn summary_line(b: &Battle) -> String {
    format!("{} · {} · {} v {}", name_of(b), cap(b.difficulty), b.units[0], b.units[1])
}

/// "Victory vs Difficult in 02:31 · lost 1 of 9" — the debrief's own words.
pub fn result_line(b: &Battle, o: &Outcome) -> String {
    format!(
        "{} vs {} in {} · lost {} of {}",
        verdict(o),
        cap(b.difficulty),
        clock(o.seconds),
        o.stats[0][0],
        b.units[0]
    )
}

/// The body a challenge is posted with. Written HERE from the decoded code,
/// never taken from the window that asked: the simulator loads codes other
/// people paste, so what it can put in front of a room is a battle, not text.
pub fn challenge_body(battle: &str, b: &Battle, result: Option<(&str, &Outcome)>) -> String {
    match result {
        Some((r, o)) => format!(
            "{} · to beat: {} in {} — {}",
            summary_line(b),
            verdict(o),
            clock(o.seconds),
            link(battle, Some(r))
        ),
        None => format!("{} — {}", summary_line(b), link(battle, None)),
    }
}

pub fn result_body(battle: &str, result: &str, b: &Battle, o: &Outcome) -> String {
    format!("{} — {}", result_line(b, o), link(battle, Some(result)))
}

fn is_matrix_user(s: &str) -> bool {
    s.starts_with('@') && s.contains(':') && s.len() <= 255 && !s.chars().any(|c| c.is_whitespace() || c.is_control())
}

/// The decoded facts every reader wants, beside the codes.
fn describe(battle: &str, b: &Battle, result: Option<(&str, &Outcome)>) -> Value {
    let mut v = json!({
        "battle": battle,
        "name": name_of(b),
        "difficulty": b.difficulty,
        "block_ms": b.block_ms,
        "units": [b.units[0], b.units[1]],
        "link": link(battle, result.map(|(r, _)| r)),
    });
    if let Some((r, o)) = result {
        v["result"] = json!(r);
        v["outcome"] = outcome_json(b, o);
    }
    v
}

pub fn outcome_json(b: &Battle, o: &Outcome) -> Value {
    json!({
        "winner": o.winner,
        "verdict": verdict(o),
        "forfeit": o.forfeit,
        "stalemate": o.stalemate,
        "revision": o.revision,
        "current": o.revision == RULES_REVISION,
        "blocks": o.blocks,
        "seconds": o.seconds,
        "time": clock(o.seconds),
        "lost": o.stats[0][0],
        "fielded": b.units[0],
        "lost_them": o.stats[1][0],
        "line": result_line(b, o),
    })
}

/// One frame, strictly. Unknown versions, unknown kinds, codes that do not
/// decode and results that do not fit their battle are all `None`: this is
/// other people's JSON, and a half-read frame drawn as a card invites
/// somebody to play a battle that is not the one they think.
pub fn parse(frame: &Value) -> Option<Value> {
    if frame.get("v").and_then(|v| v.as_u64()) != Some(1) {
        return None;
    }
    let kind = frame.get("kind").and_then(|k| k.as_str())?;
    let battle = frame.get("battle").and_then(|b| b.as_str())?;
    let b = decode_battle(battle)?;
    let result = match frame.get("result") {
        None | Some(Value::Null) => None,
        Some(r) => {
            let r = r.as_str()?;
            let o = decode_result(r)?;
            if !result_fits(&b, &o) {
                return None;
            }
            Some((r, o))
        }
    };
    let mut out = describe(battle, &b, result.as_ref().map(|(r, o)| (*r, o)));
    match kind {
        "challenge" => {
            if let Some(to) = frame.get("to") {
                let list = to.as_array()?;
                if list.len() > MAX_TO || !list.iter().all(|u| u.as_str().is_some_and(is_matrix_user)) {
                    return None;
                }
                out["to"] = to.clone();
            }
        }
        "invite" => {
            // A live battle: the match room it is played in, at a block time
            // the chain uses. `to` names who it is for; none means anyone in
            // the room may take it.
            let room = frame.get("match").and_then(|m| m.as_str())?;
            if !is_room_id(room) {
                return None;
            }
            let block_ms = frame.get("block_ms").and_then(|b| b.as_u64())?;
            if !BLOCK_MS.contains(&(block_ms as u32)) {
                return None;
            }
            out["match"] = json!(room);
            out["block_ms"] = json!(block_ms);
            if let Some(to) = frame.get("to") {
                let list = to.as_array()?;
                if list.len() > 1 || !list.iter().all(|u| u.as_str().is_some_and(is_matrix_user)) {
                    return None;
                }
                out["to"] = to.clone();
            }
        }
        "result" => {
            result.as_ref()?;
            if let Some(top) = frame.get("top") {
                out["top"] = json!(top.as_bool()?);
            }
            if let Some(beat) = frame.get("beat") {
                let u = beat.as_str()?;
                if !is_matrix_user(u) {
                    return None;
                }
                out["beat"] = json!(u);
            }
        }
        _ => return None,
    }
    out["kind"] = json!(kind);
    out["v"] = json!(1);
    Some(out)
}

/// A sim link anywhere in a body: `structs.app/sim/<code>[/<result>]` or
/// `structs://sim/<code>[/<result>]`. The first that decodes wins; a result
/// segment that does not decode (or does not fit) is dropped and the battle
/// kept — a good battle never loses to a bad score, as on the site.
pub fn from_body(body: &str) -> Option<Value> {
    for marker in ["structs.app/sim/", "structs://sim/"] {
        let mut rest = body;
        while let Some(at) = rest.find(marker) {
            let after = &rest[at + marker.len()..];
            let code: String = after.bytes().take_while(|b| b_64(*b)).map(|b| b as char).collect();
            let tail = &after[code.len()..];
            let result: Option<String> = tail
                .strip_prefix('/')
                .map(|t| t.bytes().take_while(|b| b_64(*b)).map(|b| b as char).collect::<String>())
                .filter(|r| !r.is_empty());
            if let Some(b) = decode_battle(&code) {
                let r = result
                    .as_deref()
                    .and_then(|r| decode_result(r).map(|o| (r, o)))
                    .filter(|(_, o)| result_fits(&b, o));
                let mut out = describe(&code, &b, r.as_ref().map(|(r, o)| (*r, o)));
                out["kind"] = json!(if r.is_some() { "result" } else { "challenge" });
                out["pasted"] = json!(true);
                out["v"] = json!(1);
                return Some(out);
            }
            rest = &rest[at + marker.len()..];
        }
    }
    None
}

fn b_64(b: u8) -> bool {
    b64url_char(b)
}

/// The frame a message carries, in whichever of the shapes it arrived.
pub fn parse_event(etype: &str, content: &Value, body: &str) -> Option<Value> {
    if etype == EVENT_TYPE {
        return None; // live frames: read by the match, never drawn as a card
    }
    if etype != "m.room.message" {
        return None;
    }
    match content.get(KEY) {
        Some(frame) => parse(frame),
        None => from_body(body),
    }
}

fn is_room_id(s: &str) -> bool {
    s.starts_with('!') && s.len() <= 255 && !s.chars().any(|c| c.is_whitespace() || c.is_control())
}

// ── Live ────────────────────────────────────────────────────────────────────
//
// A live battle is played in its own private room (the MATCH room), joinable
// by anyone in the room the invite was posted in. The host's simulator is the
// chain: it sends a `tick` per block carrying what its Map Viewer was shown;
// the guest sends `move`s; a watcher reads the ticks and sends nothing. These
// are typed `structs.sim` events — no body, so no other client shows them and
// no push rule counts them — the work bus's pattern. How it went is posted
// back as a `status` frame in the invite's thread, where the card reads it.

/// The frames a match is made of.
pub const LIVE_KINDS: [&str; 9] = ["hello", "ready", "start", "tick", "move", "end", "leave", "ping", "status"];
/// What a tick may carry: the Map Viewer's own events, by name.
const TICK_EVENTS: [&str; 6] = ["raid-block", "raid-delta", "raid-attacks", "raid-log", "raid-tx", "raid-snapshot"];
/// Under the homeserver's 65,536-byte event cap, with room for the envelope.
pub const LIVE_MAX_BYTES: usize = 60_000;
const STATES: [&str; 4] = ["lobby", "live", "ended", "cancelled"];
/// The map's own action vocabulary (simulator-host.js `act`).
const MOVES: [&str; 8] = ["attack", "defend", "defense_clear", "deploy", "stealth_activate", "stealth_deactivate", "activate", "deactivate"];

/// One live frame, checked for shape and size. The content of a tick is the
/// host's to vouch for — it is what its own board showed — but only events
/// the Map Viewer knows travel, and nothing travels that is too big to post.
pub fn parse_live(frame: &Value) -> Option<Value> {
    if frame.get("v").and_then(|v| v.as_u64()) != Some(1) {
        return None;
    }
    let kind = frame.get("kind").and_then(|k| k.as_str())?;
    if !LIVE_KINDS.contains(&kind) {
        return None;
    }
    if serde_json::to_vec(frame).ok()?.len() > LIVE_MAX_BYTES {
        return None;
    }
    match kind {
        "tick" => {
            frame.get("block").and_then(|b| b.as_u64())?;
            let events = frame.get("events").and_then(|e| e.as_array())?;
            let ok = events.iter().all(|e| {
                e.as_array().is_some_and(|pair| {
                    pair.len() == 2 && pair[0].as_str().is_some_and(|n| TICK_EVENTS.contains(&n))
                })
            });
            if !ok {
                return None;
            }
        }
        "move" => {
            let action = frame.get("action").and_then(|a| a.as_str())?;
            if !MOVES.contains(&action) || !frame.get("args").is_some_and(|a| a.is_object()) {
                return None;
            }
        }
        "start" => {
            frame.get("battle").and_then(|b| b.as_str()).filter(|b| decode_battle(b).is_some())?;
        }
        "status" => {
            let state = frame.get("state").and_then(|s| s.as_str())?;
            if !STATES.contains(&state) {
                return None;
            }
            for key in ["guest", "winner"] {
                if let Some(u) = frame.get(key) {
                    if !u.is_null() && !u.as_str().is_some_and(is_matrix_user) {
                        return None;
                    }
                }
            }
        }
        _ => {}
    }
    Some(frame.clone())
}

/// Every live frame in a `/sync` response, by room: what the simulator's
/// match listens for. Malformed frames are dropped here, once.
pub fn live_frames_in(sync: &Value) -> Vec<Value> {
    let mut out = Vec::new();
    let Some(rooms) = sync.get("rooms").and_then(|r| r.get("join")).and_then(|j| j.as_object()) else {
        return out;
    };
    for (room_id, room) in rooms {
        let Some(events) = room.get("timeline").and_then(|t| t.get("events")).and_then(|e| e.as_array()) else {
            continue;
        };
        for ev in events {
            if ev.get("type").and_then(|t| t.as_str()) != Some(EVENT_TYPE) {
                continue;
            }
            let Some(frame) = ev.get("content").and_then(parse_live) else { continue };
            out.push(json!({
                "room_id": room_id,
                "sender": ev.get("sender"),
                "event_id": ev.get("event_id"),
                "ts": ev.get("origin_server_ts"),
                "thread": ev.get("content").and_then(|c| c.get("m.relates_to")).and_then(|r| r.get("event_id")),
                "frame": frame,
            }));
        }
    }
    out
}

/// The body an invite is posted with: whom it is for, or anyone.
pub fn invite_body(battle: &str, b: &Battle, for_name: Option<&str>) -> String {
    match for_name {
        Some(n) => format!("Live battle for {} — {} — {}", n, summary_line(b), link(battle, None)),
        None => format!("Live battle, first to accept plays — {} — {}", summary_line(b), link(battle, None)),
    }
}

/// One run on a ladder: who, when, and what they claim.
#[derive(Debug, Clone)]
pub struct Run {
    pub sender: String,
    pub name: String,
    pub player_id: Option<String>,
    pub pfp_attrs: Option<String>,
    pub ts: u64,
    pub event_id: String,
    pub result: String,
}

/// Lower is better: a win beats a draw beats a defeat; then fewer of your
/// own structs lost; then fewer blocks; then less time.
pub fn rank_key(o: &Outcome) -> (u8, u8, u16, u16) {
    let w = match o.winner {
        "player" => 0,
        "draw" => 1,
        _ => 2,
    };
    (w, o.stats[0][0], o.blocks, o.seconds)
}

/// Every run on `battle`, best per person, ranked. Runs on the current rules
/// first; older-rules runs follow, marked, since they played a different
/// game. A run whose code does not decode is not a run.
pub fn ladder(battle: &str, runs: &[Run]) -> Vec<Value> {
    let Some(b) = decode_battle(battle) else { return Vec::new() };
    let mut best: Vec<(Run, Outcome)> = Vec::new();
    for r in runs {
        let Some(o) = decode_result(&r.result) else { continue };
        if !result_fits(&b, &o) {
            continue;
        }
        let better = |held: &(Run, Outcome)| {
            let a = ((o.revision != RULES_REVISION) as u8, rank_key(&o), r.ts);
            let h = ((held.1.revision != RULES_REVISION) as u8, rank_key(&held.1), held.0.ts);
            a < h
        };
        match best.iter().position(|(h, _)| h.sender == r.sender) {
            Some(i) => {
                if better(&best[i]) {
                    best[i] = (r.clone(), o);
                }
            }
            None => best.push((r.clone(), o)),
        }
    }
    best.sort_by(|(ra, a), (rb, bb)| {
        ((a.revision != RULES_REVISION) as u8, rank_key(a), ra.ts)
            .cmp(&((bb.revision != RULES_REVISION) as u8, rank_key(bb), rb.ts))
    });
    best.into_iter()
        .enumerate()
        .map(|(i, (r, o))| {
            json!({
                "rank": i + 1,
                "sender": r.sender,
                "name": r.name,
                "player_id": r.player_id,
                "pfp_attrs": r.pfp_attrs,
                "ts": r.ts,
                "event_id": r.event_id,
                "result": r.result,
                "outcome": outcome_json(&b, &o),
            })
        })
        .collect()
}

/// Whether `result` would take first place from whoever holds it now, and
/// who that is. `None` holder means the ladder was empty.
pub fn would_top(ladder: &[Value], me: &str, result: &str) -> (bool, Option<String>) {
    let Some(o) = decode_result(result) else { return (false, None) };
    let mine = ((o.revision != RULES_REVISION) as u8, rank_key(&o));
    let first = ladder.iter().find(|e| e.get("outcome").and_then(|x| x.get("current")).and_then(|c| c.as_bool()) == Some(true));
    let Some(first) = first else { return (o.revision == RULES_REVISION, None) };
    let holder = first.get("sender").and_then(|s| s.as_str()).unwrap_or("");
    let held = first.get("result").and_then(|r| r.as_str()).and_then(decode_result);
    let Some(held) = held else { return (true, None) };
    let theirs = ((held.revision != RULES_REVISION) as u8, rank_key(&held));
    if mine < theirs {
        (true, (holder != me && !holder.is_empty()).then(|| holder.to_string()))
    } else {
        (false, None)
    }
}

/// Whether `result` improves on `me`'s own best on this ladder (or `me` has
/// none yet) — the only runs that post themselves.
pub fn is_personal_best(ladder: &[Value], me: &str, result: &str) -> bool {
    let Some(o) = decode_result(result) else { return false };
    let mine = ladder.iter().find(|e| e.get("sender").and_then(|s| s.as_str()) == Some(me));
    let Some(held) = mine.and_then(|e| e.get("result")).and_then(|r| r.as_str()).and_then(decode_result) else {
        return true;
    };
    ((o.revision != RULES_REVISION) as u8, rank_key(&o)) < ((held.revision != RULES_REVISION) as u8, rank_key(&held))
}

#[cfg(test)]
mod tests {
    use super::*;

    // A 9 v 9 Difficult battle on the seed "spearpoint", 2 s blocks, charge
    // 9/9 — encoded by frontend/simcode.js.
    fn battle() -> String {
        // version 1, flags difficult|2s, charge 9 9, seed, 18 units.
        let mut out: Vec<u8> = vec![1, 1, 9, 9, 10];
        out.extend_from_slice(b"spearpoint");
        out.push(18);
        for side in 0..2u16 {
            // command ship (type 1) on land, slot 0, guarded by nothing
            let v: u16 = (side << 15) | (1 << 10) | (2 << 8);
            out.extend_from_slice(&v.to_be_bytes());
            for k in 0..8u16 {
                let ambit = k / 2;
                let slot = k % 2;
                let v: u16 = (side << 15) | (2 << 10) | (ambit << 8) | (slot << 6);
                out.extend_from_slice(&v.to_be_bytes());
            }
        }
        URL_SAFE_NO_PAD.encode(out)
    }

    fn result(winner: u8, lost: u8, blocks: u16, seconds: u16, revision: u8) -> String {
        let mut b = vec![1, winner, revision];
        b.extend_from_slice(&blocks.to_be_bytes());
        b.extend_from_slice(&seconds.to_be_bytes());
        b.extend_from_slice(&[lost, 20, 18, 3, 2, 4]);
        b.extend_from_slice(&[5, 18, 10, 2, 1, 3]);
        URL_SAFE_NO_PAD.encode(b)
    }

    #[test]
    fn a_battle_header_decodes_like_simcode() {
        let b = decode_battle(&battle()).unwrap();
        assert_eq!(b.difficulty, "difficult");
        assert_eq!(b.block_ms, 2000);
        assert_eq!(b.seed, "spearpoint");
        assert_eq!(b.units, [9, 9]);
        assert_eq!(summary_line(&b), "Spearpoint · Difficult · 9 v 9");
    }

    #[test]
    fn anything_else_is_not_a_battle() {
        assert!(decode_battle("AQ").is_none(), "too short");
        assert!(decode_battle("not a code!").is_none(), "alphabet");
        let mut bad = battle();
        bad.push_str("AA");
        assert!(decode_battle(&bad).is_none(), "trailing bytes");
        assert!(decode_battle(&URL_SAFE_NO_PAD.encode([2u8, 1, 9, 9, 0, 0])).is_none(), "version");
        assert!(decode_battle(&URL_SAFE_NO_PAD.encode([1u8, 1, 31, 9, 0, 0])).is_none(), "charge over 30");
    }

    #[test]
    fn a_result_reads_as_the_debrief_says_it() {
        let b = decode_battle(&battle()).unwrap();
        let o = decode_result(&result(0, 1, 76, 151, 1)).unwrap();
        assert_eq!(result_line(&b, &o), "Victory vs Difficult in 02:31 · lost 1 of 9");
        let f = decode_result(&result(1 | 4, 3, 40, 70, 1)).unwrap();
        assert_eq!(verdict(&f), "Forfeit");
        assert!(decode_result(&result(0 | 4, 1, 1, 1, 1)).is_none(), "a forfeit the player won");
        assert!(decode_result(&result(0 | (1 << 3), 1, 1, 1, 1)).is_none(), "a stalemate with a winner");
        assert_eq!(clock(3725), "1:02:05");
    }

    #[test]
    fn frames_are_strict() {
        let battle = battle();
        let ok = json!({ "v": 1, "kind": "challenge", "battle": battle });
        assert_eq!(parse(&ok).unwrap()["name"], "Spearpoint");
        assert!(parse(&json!({ "v": 2, "kind": "challenge", "battle": battle })).is_none(), "version");
        assert!(parse(&json!({ "v": 1, "kind": "brag", "battle": battle })).is_none(), "kind");
        assert!(parse(&json!({ "v": 1, "kind": "result", "battle": battle })).is_none(), "a result needs a result");
        let r = result(0, 1, 76, 151, 1);
        assert!(parse(&json!({ "v": 1, "kind": "result", "battle": battle, "result": r })).is_some());
        assert!(
            parse(&json!({ "v": 1, "kind": "result", "battle": battle, "result": result(0, 12, 1, 1, 1) })).is_none(),
            "lost 12 of 9"
        );
        assert!(parse(&json!({ "v": 1, "kind": "challenge", "battle": battle, "to": ["1-61"] })).is_none(), "to is a matrix id");
        assert!(parse(&json!({ "v": 1, "kind": "challenge", "battle": battle, "to": ["@1-61:h"] })).is_some());
    }

    #[test]
    fn a_pasted_link_is_a_challenge_and_a_bad_score_keeps_the_battle() {
        let b = battle();
        let r = result(0, 1, 76, 151, 1);
        let f = from_body(&format!("beat this https://structs.app/sim/{b}/{r} lol")).unwrap();
        assert_eq!(f["kind"], "result");
        assert_eq!(f["result"], r);
        let g = from_body(&format!("structs://sim/{b}/garbage")).unwrap();
        assert_eq!(g["kind"], "challenge");
        assert!(g.get("result").is_none());
        assert!(from_body("https://structs.app/player/1-61").is_none());
        assert!(from_body("https://structs.app/sim/xx").is_none());
    }

    #[test]
    fn the_body_is_built_here_from_the_code() {
        let b = battle();
        let d = decode_battle(&b).unwrap();
        let r = result(0, 1, 76, 151, 1);
        let o = decode_result(&r).unwrap();
        assert_eq!(challenge_body(&b, &d, None), format!("Spearpoint · Difficult · 9 v 9 — https://structs.app/sim/{b}"));
        assert_eq!(result_body(&b, &r, &d, &o), format!("Victory vs Difficult in 02:31 · lost 1 of 9 — https://structs.app/sim/{b}/{r}"));
        // …and reads back as the same frame.
        assert_eq!(from_body(&result_body(&b, &r, &d, &o)).unwrap()["result"], r);
    }

    #[test]
    fn an_invite_names_its_match_room_and_a_chain_block_time() {
        let b = battle();
        let ok = json!({ "v": 1, "kind": "invite", "battle": b, "match": "!m:h", "block_ms": 6000 });
        assert_eq!(parse(&ok).unwrap()["match"], "!m:h");
        assert!(parse(&json!({ "v": 1, "kind": "invite", "battle": b, "match": "m:h", "block_ms": 6000 })).is_none(), "a room id");
        assert!(parse(&json!({ "v": 1, "kind": "invite", "battle": b, "match": "!m:h", "block_ms": 3000 })).is_none(), "2 s or 6 s");
        assert!(parse(&json!({ "v": 1, "kind": "invite", "battle": b, "match": "!m:h", "block_ms": 6000, "to": ["@a:h", "@b:h"] })).is_none(), "one guest");
    }

    #[test]
    fn live_frames_are_checked_for_shape_and_size() {
        let tick = |events: Value| json!({ "v": 1, "kind": "tick", "block": 7, "events": events });
        assert!(parse_live(&tick(json!([["raid-block", { "height": 7 }], ["raid-log", { "rows": [] }]]))).is_some());
        assert!(parse_live(&tick(json!([["mcp_transfer", {}]]))).is_none(), "only the Map Viewer's events travel");
        assert!(parse_live(&tick(json!([["raid-block"]]))).is_none(), "a name and a payload");
        let huge = "x".repeat(LIVE_MAX_BYTES);
        assert!(parse_live(&tick(json!([["raid-log", { "rows": [huge] }]]))).is_none(), "too big to post");
        assert!(parse_live(&json!({ "v": 1, "kind": "move", "action": "attack", "args": { "attacker_id": "5-1" } })).is_some());
        assert!(parse_live(&json!({ "v": 1, "kind": "move", "action": "build", "args": {} })).is_none(), "a battle has no building");
        assert!(parse_live(&json!({ "v": 1, "kind": "status", "state": "ended", "winner": "@a:h" })).is_some());
        assert!(parse_live(&json!({ "v": 1, "kind": "status", "state": "won" })).is_none());
        assert!(parse_live(&json!({ "v": 1, "kind": "gossip" })).is_none());
    }

    #[test]
    fn a_sync_yields_its_live_frames_and_nothing_else() {
        let sync = json!({ "rooms": { "join": { "!m:h": { "timeline": { "events": [
            { "type": EVENT_TYPE, "sender": "@a:h", "event_id": "$1", "origin_server_ts": 5, "content": { "v": 1, "kind": "ping" } },
            { "type": EVENT_TYPE, "sender": "@a:h", "event_id": "$2", "content": { "v": 1, "kind": "nonsense" } },
            { "type": "m.room.message", "sender": "@a:h", "event_id": "$3", "content": { "body": "hi" } },
        ] } } } } });
        let got = live_frames_in(&sync);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0]["room_id"], "!m:h");
        assert_eq!(got[0]["frame"]["kind"], "ping");
    }

    fn run(who: &str, ts: u64, r: String) -> Run {
        Run { sender: who.into(), name: who.into(), player_id: None, pfp_attrs: None, ts, event_id: format!("${ts}"), result: r }
    }

    #[test]
    fn the_ladder_keeps_each_persons_best_and_ranks_win_lost_blocks() {
        let b = battle();
        let runs = vec![
            run("@a:h", 1, result(1, 9, 150, 302, 1)), // a: defeat
            run("@a:h", 2, result(0, 2, 90, 175, 1)),  // a: better, a win
            run("@b:h", 3, result(0, 1, 76, 151, 1)),  // b: win, lost 1
            run("@c:h", 4, result(0, 1, 70, 160, 1)),  // c: win, lost 1, fewer blocks
            run("@d:h", 5, result(0, 0, 40, 80, 0)),   // d: older rules — after everyone
        ];
        let l = ladder(&b, &runs);
        let order: Vec<&str> = l.iter().map(|e| e["sender"].as_str().unwrap()).collect();
        assert_eq!(order, ["@c:h", "@b:h", "@a:h", "@d:h"]);
        assert_eq!(l[2]["outcome"]["lost"], 2, "a's best, not their first");
        assert_eq!(l[3]["outcome"]["current"], false);
    }

    #[test]
    fn a_run_tops_the_ladder_only_by_beating_first_place() {
        let b = battle();
        let l = ladder(&b, &[run("@c:h", 1, result(0, 1, 70, 160, 1))]);
        assert_eq!(would_top(&l, "@me:h", &result(0, 1, 60, 150, 1)), (true, Some("@c:h".into())));
        assert_eq!(would_top(&l, "@me:h", &result(0, 2, 60, 150, 1)), (false, None));
        assert_eq!(would_top(&l, "@c:h", &result(0, 0, 60, 150, 1)), (true, None), "beating yourself names nobody");
        assert_eq!(would_top(&[], "@me:h", &result(1, 9, 60, 150, 1)), (true, None), "first on an empty ladder");
        assert!(is_personal_best(&l, "@me:h", &result(1, 9, 1, 1, 1)), "a first run is a best");
        assert!(!is_personal_best(&l, "@c:h", &result(0, 1, 80, 160, 1)), "slower than your own");
        assert!(is_personal_best(&l, "@c:h", &result(0, 0, 80, 160, 1)), "fewer lost beats fewer blocks");
    }
}
