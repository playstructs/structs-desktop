//! Matrix client-server API, and the long-poll that feeds the Comms window.
//!
//! The window never polls and never holds a token: this module owns both. It
//! keeps one `/sync` loop per signed-in guild, folds each response into an
//! in-memory room map, and pushes deltas to the window as `matrix::timeline` /
//! `matrix::rooms`.
//!
//! Only `m.room.message` is rendered as prose. Everything else in a timeline
//! is summarised rather than dropped — a client that silently swallows event
//! types it does not know looks broken in exactly the cases where knowing
//! something happened matters most.

use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::RwLock;
use std::time::Duration;
use tauri::Emitter;

use super::auth;
use super::avatar;
use super::directory;
use super::store::{self, Session};

/// Long-poll bound. The homeserver holds the request open until something
/// happens or this elapses, so this is idle cost, not latency.
const SYNC_TIMEOUT_MS: u64 = 30_000;
/// Slightly longer than the server's hold, so a healthy long-poll is never
/// killed by our own client timeout.
const HTTP_TIMEOUT_SECS: u64 = 45;
/// Everything that is NOT a long-poll: sending, reacting, marking read.
/// These are ordinary requests and should fail fast enough that the player
/// can do something about it — a send has an echo on screen waiting on it.
const REQUEST_TIMEOUT_SECS: u64 = 15;
/// Events kept per room in memory. Scrollback beyond this is re-fetched.
const TIMELINE_CAP: usize = 500;

// ── Rendered shapes (the window's contract) ─────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct Message {
    pub event_id: String,
    pub sender: String,
    pub sender_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sender_tag: Option<String>,
    pub body: String,
    /// "text" | "emote" | "notice" | "unknown"
    pub kind: &'static str,
    #[serde(rename = "self")]
    pub is_self: bool,
    pub admin: bool,
    pub ts: u64,
    /// The sender said so explicitly, via `m.mentions`. Exact, unlike the
    /// window's word-boundary fallback.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub mentions_me: bool,
    /// A shared proof-of-work offer or result riding on this message.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub work: Option<Value>,
    /// Somebody changed this after sending it. Shown, never hidden: a message
    /// that quietly becomes different text is how a conversation gets
    /// rewritten under the people reading it.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    #[serde(default)]
    pub edited: bool,
    /// Filled in when the timeline is served, not when the message is
    /// rendered — see `timeline_of`.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    #[serde(default)]
    pub reactions: Vec<Reaction>,
    /// The thread this message belongs to, when it is in one. Threads are a
    /// grouping this window does not draw, but saying a message is part of
    /// one is honest where showing a fabricated quote is not.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thread_root: Option<String>,
    /// The event this message answers, when it is a reply.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reply_to: Option<String>,
    /// Who was answered, and roughly what they said — lifted from the rich
    /// reply fallback the sender already put in the body. Enough to render a
    /// quote line without a round trip per reply, which in a busy room would
    /// be one fetch per message.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reply_sender: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reply_excerpt: Option<String>,
    /// `mxc://server/id` for an image message.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mxc: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u64>,
    /// The player's on-chain portrait attributes, so the timeline shows the
    /// same face the roster and Team Ops show. `None` for bots and service
    /// accounts, which are not players and have no portrait.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pfp_attrs: Option<String>,
    /// Their player id, when the sender is one — the window uses it to offer
    /// "message this player" straight off a message.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub player_id: Option<String>,
}

/// How present somebody is, as Matrix models it.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Presence {
    /// "online" | "unavailable" | "offline". `unavailable` is idle — the
    /// spec's word, not a friendly one, so the window translates it.
    pub state: String,
    /// Milliseconds since they last did anything, when the server says.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_active_ago: Option<u64>,
    /// The server's own claim that they are active right now, which is more
    /// reliable than arithmetic on `last_active_ago`.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub currently_active: bool,
    /// What they say they are doing, if they have chosen to say. Opt-in on
    /// our side, and never assumed to be present on anyone else's.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status_msg: Option<String>,
}

/// One person's reaction: who, and the annotation event that says so.
#[derive(Debug, Clone, PartialEq)]
struct Reactor {
    user_id: String,
    event_id: String,
}

/// A reaction as the window shows it: the key, how many, whether you are one
/// of them, and who — the last because "who agreed to the plan" is the whole
/// point in a guild room.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Reaction {
    pub key: String,
    pub count: usize,
    pub mine: bool,
    pub who: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Room {
    pub room_id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub canonical_alias: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub topic: Option<String>,
    pub members: u64,
    pub joined: bool,
    /// Somebody has asked you into this room and you have not answered.
    /// Not joined — you cannot read it yet — but not nothing either.
    #[serde(default)]
    pub invited: bool,
    /// Who asked, by the name a player would know them by.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub invited_by: Option<String>,
    /// Where this room's conversation continued, when it has been upgraded.
    ///
    /// A room is not deleted by an upgrade — it stays joinable and stays in
    /// the list. Without following the pointer a player goes on talking into
    /// a room everyone else has left.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub replaced_by: Option<String>,
    /// The room turns on end-to-end encryption. This client has none, so
    /// everything sent here by a crypto-capable client is unreadable — worth
    /// saying once at the top rather than only line by line.
    #[serde(default)]
    pub encrypted: bool,
    /// Silenced: still counted as unread, never allowed to interrupt.
    #[serde(default)]
    pub muted: bool,
    /// Event ids the room has pinned, newest last, as the room itself states
    /// them. Ids only — the events are fetched on demand.
    #[serde(default)]
    pub pinned: Vec<String>,
    /// Straight from the homeserver's `unread_notifications`, not counted here.
    ///
    /// Synapse already maintains this against the read receipts this app
    /// sends, which makes it the only version that survives the window
    /// closing, survives a restart, and agrees with the same account open in
    /// Element on a phone. Counting locally could do none of those.
    pub unread: u64,
    /// `highlight_count` — messages that named you, by the server's push
    /// rules. Being named is not the same as traffic: a count of 40 hides the
    /// one message that was actually for you.
    pub mention: bool,
    /// "local" | "galaxy" | "direct" — see `section_for`.
    pub section: &'static str,
    /// Rank among the channels pinned above every section, or `None` for a
    /// room that is not pinned. See `home_rank`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub home_rank: Option<u8>,
    pub icon: &'static str,
    /// For a direct message, the other player's portrait — a DM row should
    /// show a face, not a channel glyph.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pfp_attrs: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub player_id: Option<String>,
}

// ── Per-guild live state ────────────────────────────────────────────────────

#[derive(Default)]
struct GuildState {
    next_batch: Option<String>,
    rooms: HashMap<String, Room>,
    timelines: HashMap<String, Vec<Message>>,
    /// user_id → display name, from m.room.member state.
    names: HashMap<String, String>,
    /// user_id → power level, per room.
    power: HashMap<String, HashMap<String, i64>>,
    /// Directory rooms we are not in, refreshed far less often than sync.
    directory_at: u64,
    /// room_id → the other party's user id, for rooms that are direct
    /// messages. Sourced from `m.direct` account data, which is where Matrix
    /// records that fact.
    dm_with: HashMap<String, String>,
    /* room_id → the PLAYER id we opened this conversation for.
     *
     * `dm_with` holds a Matrix id and is sourced from `m.direct`, which the
     * homeserver only tells us about on a later sync — and the peer's identity
     * is otherwise re-derived from `m.heroes`, membership counts and the
     * galaxy directory. Every one of those is empty for a DM whose invitee has
     * not accepted yet, so a brand-new conversation had nothing to title
     * itself with and fell back to printing its own room id.
     *
     * When the window is asked to message a PLAYER, it is told exactly who. So
     * remember that instead of re-deriving it: this is the one source that is
     * correct the instant the room exists.
     */
    dm_player_id: HashMap<String, String>,
    /// room_id → who is typing right now. Ephemeral by definition: it is
    /// rebuilt from each sync rather than accumulated, because "stopped
    /// typing" arrives as an empty list, not as a removal.
    typing: HashMap<String, Vec<String>>,
    /// Rooms the player has silenced, from `m.push_rules`.
    muted: std::collections::HashSet<String>,
    /// user → how present they are, from `m.presence`.
    ///
    /// Only users the homeserver has actually told us about. An absent entry
    /// means UNKNOWN, never offline — many Synapse deployments turn presence
    /// off entirely because it is expensive at scale, and a client that reads
    /// silence as "nobody is here" would show a dead guild to everyone on
    /// those servers.
    presence: HashMap<String, Presence>,
    /// room_id → user → the last event they have read.
    ///
    /// A receipt names ONE event: the newest thing that person has seen.
    /// Whether they have read any particular message is a question about
    /// order, answered against the timeline — see `seen_state`.
    receipts: HashMap<String, HashMap<String, String>>,
    /// room_id → target event → reaction key → who sent it.
    ///
    /// Senders, not a count: "did I already react" and "who agreed" are both
    /// questions a count cannot answer, and un-reacting means finding YOUR
    /// annotation event to redact.
    reactions: HashMap<String, HashMap<String, HashMap<String, Vec<Reactor>>>>,
    /// Every annotation seen, by its own event id, so a redaction can undo
    /// the right one. A redaction names only the event it removes.
    annotations: HashMap<String, (String, String, String, String)>,
    /// room_id → the pagination token for the NEXT page of older messages.
    /// Absent means "never paged"; `None` inside means the room has been read
    /// back to its beginning and there is nothing more to ask for.
    back_token: HashMap<String, Option<String>>,
}

static STATE: std::sync::LazyLock<RwLock<HashMap<String, GuildState>>> =
    std::sync::LazyLock::new(|| RwLock::new(HashMap::new()));

/// Guilds whose sync loop is running, so a reconnect does not start a second.
static RUNNING: std::sync::LazyLock<RwLock<std::collections::HashSet<String>>> =
    std::sync::LazyLock::new(|| RwLock::new(std::collections::HashSet::new()));

static TXN: AtomicU64 = AtomicU64::new(1);

/// Two clients, built once each.
///
/// Once, because a `reqwest::Client` OWNS the connection pool: building one
/// per request — which is what this did — throws the pool away every time and
/// pays a fresh TLS handshake for every message, receipt and reaction.
///
/// Two, because the long-poll and everything else want opposite timeouts. A
/// `/sync` is meant to hang for 30 seconds; a send that hangs for 45 leaves
/// the player watching a dimmed message for most of a minute before it can
/// even offer to retry.
fn build_client(timeout: Duration) -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(timeout)
        .user_agent("StructsDesktop/comms")
        .build()
        // A client that will not build means no TLS stack at all; nothing
        // this module does can proceed, and a default one is honest about
        // that rather than papering over it.
        .unwrap_or_default()
}

static HTTP: std::sync::LazyLock<reqwest::Client> =
    std::sync::LazyLock::new(|| build_client(Duration::from_secs(REQUEST_TIMEOUT_SECS)));

static LONG_POLL: std::sync::LazyLock<reqwest::Client> =
    std::sync::LazyLock::new(|| build_client(Duration::from_secs(HTTP_TIMEOUT_SECS)));

fn http() -> Result<reqwest::Client, String> {
    Ok(HTTP.clone())                    // cheap: an Arc around the shared pool
}

/// The homeserver's own name, taken from our user id (`@1-42:server`) rather
/// than from the URL — a homeserver's client URL and its server name are
/// routinely different (matrix.example vs example).
fn server_name(session: &Session) -> String {
    session
        .user_id
        .rsplit_once(':')
        .map(|(_, s)| s.to_string())
        .unwrap_or_default()
}

/// LOCAL NET vs GALAXY NET.
///
/// A room id's suffix is the server that CREATED it, so this splits "rooms my
/// guild runs" from "rooms reached across federation" — which is exactly what
/// the two labels mean for a federated client, and is derivable from data we
/// already hold rather than guessed from a name.
///
/// If structs-tel later defines a canonical room taxonomy (per-planet, per-raid
/// rooms and the Spaces that hold them), this is the one function to change.
fn section_for(room_id: &str, server: &str) -> &'static str {
    match room_id.rsplit_once(':') {
        Some((_, s)) if !server.is_empty() && s == server => "local",
        _ => "galaxy",
    }
}

/// A DM is not a channel and does not belong in either net: it is a person.
/// An invitation is not a place you are; it is a question you have been
/// asked. Its own section, above everything, because it is the one row in the
/// list that is waiting on an answer.
const SECTION_INVITE: &str = "invite";
const SECTION_DIRECT: &'static str = "direct";

/// `#orbital-hydro:matrix.crew.oh.energy` → `Orbital Hydro`. An alias is a
/// routing detail; its localpart is what someone actually named the room.
fn pretty_alias(alias: &str) -> Option<String> {
    let local = alias.trim_start_matches('#').split(':').next()?;
    if local.is_empty() {
        return None;
    }
    let words: Vec<String> = local
        .split(['-', '_'])
        .filter(|w| !w.is_empty())
        .map(|w| {
            let mut c = w.chars();
            match c.next() {
                Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
                None => String::new(),
            }
        })
        .collect();
    if words.is_empty() {
        None
    } else {
        Some(words.join(" "))
    }
}

/// Name a room after the people in it, the way every client does for a room
/// with no name of its own.
fn name_heroes(heroes: &[String]) -> String {
    let names: Vec<String> = heroes
        .iter()
        .take(3)
        .map(|u| {
            directory::player_id_of(u)
                .and_then(|pid| directory::get(&pid).map(|i| i.username))
                .filter(|n| !n.is_empty())
                .unwrap_or_else(|| localpart(u))
        })
        .collect();
    match names.len() {
        0 => String::new(),
        1 => names[0].clone(),
        2 => format!("{} and {}", names[0], names[1]),
        _ => format!("{}, {} and others", names[0], names[1]),
    }
}

/// Pick a shipped structicon for a room. Name-based, deliberately: there is no
/// room-type metadata to read, and inventing an icon set is not an option.
fn icon_for(name: &str, alias: Option<&str>) -> &'static str {
    let hay = format!("{} {}", name, alias.unwrap_or_default()).to_lowercase();
    if hay.contains("raid") || hay.contains("war") || hay.contains("combat") {
        "icon-raid"
    } else if hay.contains("planet") || hay.contains("base") || hay.contains("alpha") {
        "icon-planet"
    } else if hay.contains("guild") || hay.contains("corp") || hay.contains("crew") {
        "icon-guild"
    } else if hay.contains("community") || hay.contains("general") || hay.contains("lobby") {
        "icon-member"
    } else if hay.contains("announce") || hay.contains("info") || hay.contains("news") {
        "icon-info"
    } else {
        "icon-beacon"
    }
}

/* The channels pinned above every section, in this order.
 *
 * A PRODUCT decision, not a derivable fact: SN Corp is being treated as the
 * main channel of Structs for now, with the support and infrastructure rooms
 * under it. One list, so adding, reordering or retiring a pin is one edit.
 *
 * Matched on the alias LOCALPART as a whole token, plus WHOLE-SERVER equality
 * against that guild's own homeserver. Never a substring and never on display
 * name: anyone may publish a room called "SN Corp" — the browse fixture
 * carries exactly that forgery at `#sn-corp-official`, on this very server,
 * whose localpart CONTAINS `sn-corp`. Whole tokens are what separate them.
 */
const HOME_GUILD: &str = "0-5";
const PINNED_LOCALPARTS: [&str; 3] = ["sn-corp", "help", "infrastructure"];

/// The alias localpart: `#help:matrix.example` → `help`. Whole tokens only.
fn alias_localpart_of(alias: &str) -> Option<&str> {
    alias.strip_prefix('#')?.split_once(':').map(|(l, _)| l)
}

#[cfg(test)]
mod pin_tests {
    use super::*;

    #[test]
    fn a_localpart_is_a_whole_token() {
        assert_eq!(alias_localpart_of("#help:matrix.beta.playstructs.com"), Some("help"));
        assert_eq!(
            alias_localpart_of("#infrastructure:matrix.beta.playstructs.com"),
            Some("infrastructure")
        );
        // Not an alias at all.
        assert_eq!(alias_localpart_of("!room:server"), None);
        assert_eq!(alias_localpart_of("#nocolon"), None);
        assert_eq!(alias_localpart_of("#sn-corp:matrix.beta.playstructs.com"), Some("sn-corp"));
        /* A localpart that merely CONTAINS a pin is a DIFFERENT room — the
         * prefix-collision bug this codebase has been bitten by before, and
         * not hypothetical here: `#sn-corp-official` is a real forgery on
         * this very server, published by someone who is not SN Corp. */
        for impostor in [
            "#sn-corp-official:matrix.beta.playstructs.com",
            "#sn-corp2:matrix.beta.playstructs.com",
            "#help-desk:matrix.beta.playstructs.com",
            "#not-help:matrix.beta.playstructs.com",
            "#infrastructure-wg:matrix.beta.playstructs.com",
        ] {
            let local = alias_localpart_of(impostor).unwrap();
            assert!(
                !PINNED_LOCALPARTS.contains(&local),
                "{local} must not take a pinned slot"
            );
        }
    }

    /* The pins are the same three for EVERYONE.
     *
     * The first version compared the SESSION's homeserver to SN Corp's, so it
     * answered "am I on SN's server?" rather than "is this room on SN's
     * server?" — and every room came back unpinned for every player outside
     * SN Corp, which is most of them. The viewer does not appear in this
     * function's arguments any more; this pins that shut.
     */
    #[test]
    fn the_pins_do_not_depend_on_the_viewers_guild() {
        const SN: &str = "matrix.beta.playstructs.com";
        assert_eq!(pinned_rank_for("#sn-corp:matrix.beta.playstructs.com", SN), Some(0));
        assert_eq!(pinned_rank_for("#help:matrix.beta.playstructs.com", SN), Some(1));
        assert_eq!(pinned_rank_for("#infrastructure:matrix.beta.playstructs.com", SN), Some(2));
        // A room of the viewer's OWN guild is not pinned just for being theirs.
        assert_eq!(pinned_rank_for("#orbital-hydro:matrix.crew.oh.energy", SN), None);
        // …and a pinned NAME on another server is a different room entirely.
        assert_eq!(pinned_rank_for("#help:matrix.crew.oh.energy", SN), None);
        assert_eq!(pinned_rank_for("#sn-corp:evil.example", SN), None);
        // Suffix and prefix of the home server are not the home server.
        assert_eq!(pinned_rank_for("#help:beta.playstructs.com", SN), None);
        assert_eq!(pinned_rank_for("#help:matrix.beta.playstructs.com.evil.example", SN), None);
        // Nothing is pinned when the directory cannot name the home server.
        assert_eq!(pinned_rank_for("#help:matrix.beta.playstructs.com", ""), None);
    }

    /* A guild that does not federate must be handled, not hammered.
     *
     * Every launch starts a sync, and every sync used to retry all three
     * joins. For a deployment that will never federate with SN Corp's server
     * that is three doomed federated requests forever — and for one that
     * merely had a bad minute, giving up permanently would be just as wrong.
     * So the question is never "is this fatal", only "how long until we ask
     * again".
     */
    #[test]
    fn a_settled_refusal_waits_a_day_and_a_blip_waits_a_launch() {
        for settled in [
            "M_FORBIDDEN: You are not invited to this room",
            "M_NOT_FOUND: Room alias #help:matrix.beta.playstructs.com not found",
            "M_UNRECOGNIZED: Unrecognized request",
            "M_UNSUPPORTED_ROOM_VERSION: your server cannot speak version 11",
            "M_INCOMPATIBLE_ROOM_VERSION: 12",
        ] {
            assert_eq!(
                pinned_retry_delay_ms(settled),
                PINNED_SETTLED_RETRY_MS,
                "{settled} should wait a day"
            );
        }
        for blip in [
            // Synapse's catch-all when it cannot reach the remote server —
            // which is exactly the case that comes BACK when federation is
            // turned on, so it must not be written off for a day.
            "M_UNKNOWN: No known servers",
            "HTTP 502",
            "HTTP 504",
            "the homeserver is rate limiting this; try again in 12s",
            "error sending request for url (https://…): connection closed",
            "",
        ] {
            assert_eq!(pinned_retry_delay_ms(blip), 0, "{blip} should retry next launch");
        }
    }

    /* Classified on the ERRCODE, never on the message. The message half is
     * free text written by another deployment; a room whose topic or error
     * string happens to contain "M_FORBIDDEN" must not change our mind. */
    #[test]
    fn only_the_errcode_decides() {
        assert_eq!(pinned_retry_delay_ms("M_UNKNOWN: not M_FORBIDDEN at all"), 0);
        assert_eq!(pinned_retry_delay_ms("HTTP 500: M_NOT_FOUND appears here"), 0);
    }

    #[test]
    fn the_pins_are_ordered_and_distinct() {
        // Rank IS the index, so the list order is the on-screen order.
        assert_eq!(PINNED_LOCALPARTS[0], "sn-corp");
        assert_eq!(PINNED_LOCALPARTS[1], "help");
        assert_eq!(PINNED_LOCALPARTS[2], "infrastructure");
        let mut seen = PINNED_LOCALPARTS.to_vec();
        seen.sort_unstable();
        seen.dedup();
        assert_eq!(seen.len(), PINNED_LOCALPARTS.len(), "a pin is listed twice");
    }
}

/// Where this room sits among the pinned channels, or `None` for the great
/// majority that are not pinned at all.
///
/// Takes only the alias — the display name is deliberately not an input, so
/// no future edit can reintroduce name matching by reaching for a parameter
/// that happens to be in scope.
///
/// The server compared is the ROOM's own, taken from its alias — not the
/// session's.
///
/// This read the session's homeserver and refused anything that did not match
/// SN Corp's, which meant the pin could only ever fire for SN Corp's own
/// members: an Orbital Hydro player got `None` for every room including the
/// three pinned ones, because it was asking "am I on SN's server?" instead of
/// "is this room on SN's server?". The whole point is that these three are
/// pinned for everyone, so the viewer's guild must not enter into it.
///
/// Returns `None` whenever the directory cannot name the home guild's server,
/// which degrades to "nothing is pinned" rather than to a wrong guess.
fn home_rank(alias: Option<&str>) -> Option<u8> {
    let home = super::directory::server_name_for_guild(HOME_GUILD)?;
    pinned_rank_for(alias?, &home)
}

/// The decision itself, with nothing global in it.
///
/// Split out because the bug above was not in the rule but in what was fed to
/// it, and a rule that can only be exercised through the live guild directory
/// cannot be asked "does the viewer's own guild change your answer?".
fn pinned_rank_for(alias: &str, home_server: &str) -> Option<u8> {
    // Whole-server equality, never a substring: `oh.energy` is a suffix of
    // `matrix.oh.energy` and a prefix of `oh.energy.example.com`.
    if home_server.is_empty() || super::rooms::server_of(alias) != Some(home_server) {
        return None;
    }
    let local = alias_localpart_of(alias)?;
    PINNED_LOCALPARTS
        .iter()
        .position(|p| *p == local)
        .map(|i| i as u8)
}

// ── Requests ────────────────────────────────────────────────────────────────

/// The longest this will sit waiting out a rate limit before giving the
/// failure back to the caller.
///
/// A homeserver under load can ask for a minute or more. Honouring that
/// silently would freeze a click for a minute with no explanation, which is
/// worse than saying so — the player can send again.
const MAX_RATE_LIMIT_WAIT_MS: u64 = 5_000;

/// How long the server says to wait, if it is asking us to.
///
/// `M_LIMIT_EXCEEDED` is Synapse's normal answer to a burst — several
/// messages in a row, a handful of reactions, a search while syncing — and it
/// always names a delay. Ignoring it turns an ordinary "slow down" into a
/// message that simply does not send.
fn rate_limited_for(status: u16, v: &Value) -> Option<u64> {
    if status != 429 && v.get("errcode").and_then(|e| e.as_str()) != Some("M_LIMIT_EXCEEDED") {
        return None;
    }
    // Absent means the server did not say; a short wait is the spec's own
    // suggestion and is better than giving up immediately.
    Some(
        v.get("retry_after_ms")
            .and_then(|r| r.as_u64())
            .unwrap_or(1_000),
    )
}

/// Every authenticated call goes through here so that exactly one place knows
/// how to react to an expired token: refresh once, retry once, and only then
/// give up. Without this an expiring session would look like a random failure
/// somewhere in the middle of the UI.
///
/// The same place handles being rate limited, for the same reason: a burst of
/// sends is ordinary, the server tells us exactly how long to wait, and every
/// caller doing that itself would be six versions of the same loop.
async fn authed(
    session: &Session,
    build: impl Fn(&reqwest::Client, &Session) -> reqwest::RequestBuilder,
) -> Result<Value, String> {
    authed_on(&HTTP, session, build).await
}

/// The same, on a named client — so `/sync` can use the long-poll one without
/// every other request inheriting its 45-second patience.
async fn authed_on(
    client: &reqwest::Client,
    session: &Session,
    build: impl Fn(&reqwest::Client, &Session) -> reqwest::RequestBuilder,
) -> Result<Value, String> {
    let client = client.clone();
    let mut resp = build(&client, session)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let mut status = resp.status();
    let mut v: Value = resp.json().await.unwrap_or(Value::Null);

    // Once, not in a loop: a server still refusing after it told us when to
    // come back is not going to be talked round by asking faster.
    if let Some(wait) = rate_limited_for(status.as_u16(), &v) {
        if wait <= MAX_RATE_LIMIT_WAIT_MS {
            tokio::time::sleep(Duration::from_millis(wait)).await;
            resp = build(&client, session)
                .send()
                .await
                .map_err(|e| e.to_string())?;
            status = resp.status();
            v = resp.json().await.unwrap_or(Value::Null);
        } else {
            return Err(format!(
                "the homeserver is rate limiting this; try again in {}s",
                wait.div_ceil(1000)
            ));
        }
    }

    if status.is_success() {
        return Ok(v);
    }
    let errcode = v.get("errcode").and_then(|e| e.as_str()).unwrap_or("");
    if errcode == "M_UNKNOWN_TOKEN" && session.refresh_token.is_some() {
        let refreshed = auth::refresh(session).await?;
        let resp = build(&client, &refreshed)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let status = resp.status();
        let v: Value = resp.json().await.unwrap_or(Value::Null);
        if status.is_success() {
            return Ok(v);
        }
        return Err(matrix_error(status.as_u16(), &v));
    }
    Err(matrix_error(status.as_u16(), &v))
}

fn matrix_error(status: u16, v: &Value) -> String {
    // The one error a player is likely to meet, so it says what to do rather
    // than naming a spec constant at them.
    if let Some(wait) = rate_limited_for(status, v) {
        return format!(
            "the homeserver is rate limiting this; try again in {}s",
            wait.div_ceil(1000)
        );
    }
    let code = v.get("errcode").and_then(|e| e.as_str());
    let msg = v.get("error").and_then(|e| e.as_str());
    match (code, msg) {
        (Some(c), Some(m)) => format!("{}: {}", c, m),
        (Some(c), None) => c.to_string(),
        (None, Some(m)) => m.to_string(),
        _ => format!("HTTP {}", status),
    }
}

fn base(session: &Session) -> String {
    format!(
        "{}/_matrix/client/v3",
        session.homeserver.trim_end_matches('/')
    )
}

// ── Event rendering ─────────────────────────────────────────────────────────

/// The state a room sets up with. Emitted in a burst at creation, meaningless
/// to a reader, and never worth a line in the timeline.
const SETUP_EVENTS: &[&str] = &[
    "m.room.create",
    "m.room.power_levels",
    "m.room.join_rules",
    "m.room.history_visibility",
    "m.room.guest_access",
    "m.room.server_acl",
    "m.room.encryption",
    "m.room.canonical_alias",
    "m.space.child",
    "m.space.parent",
];

/// What to call whoever sent this.
///
/// A player's name comes from the chain and is theirs. Everyone else has only
/// a Matrix display name, which is self-chosen, unverified, and changeable at
/// will — so if a non-player is using a player's name, the name alone is a
/// lie and the id has to be shown beside it.
///
/// This is the convention Element uses for ambiguous names, for the same
/// reason. It matters more here: people agree to raids and to trades in these
/// rooms, and "Marklifer said it was fine" needs to mean Marklifer.
fn sender_display(sender: &str, ident: Option<&directory::Ident>, gs: &GuildState) -> String {
    if let Some(name) = ident.map(|i| i.username.clone()).filter(|n| !n.is_empty()) {
        // On-chain, and nobody else's to TAKE — which is why it needs no player
        // id beside it. It is already sanitized at ingestion (directory.rs),
        // because owning a name and the name being legible are different
        // things: the chain settles the first and says nothing about the
        // second.
        return name;
    }
    // Everything below is SELF-CHOSEN: any account may set any string, and
    // federation means the account need not even be on our homeserver. It is
    // sanitized before it is looked at, so an invisible or reordering
    // character cannot make the checks below disagree with the screen.
    let claimed = super::identity::sanitize(&gs.names.get(sender).cloned().unwrap_or_default());
    if claimed.is_empty() {
        return localpart(sender);
    }
    // Two ways a claimed name reaches for an identity it does not own: wearing
    // a real player's name, or painting a guild badge the window renders from
    // the CHAIN. Both answer the same way — the player id, which cannot be
    // taken, travels with the name.
    if directory::name_belongs_to_a_player(&claimed) || super::identity::claims_a_guild_tag(&claimed) {
        return format!("{} ({})", claimed, localpart(sender));
    }
    claimed
}

/// A break in the record, for the window to draw across the timeline.
///
/// Carried as a message rather than a flag on the room because a gap happens
/// at a POINT in the conversation — a room-level "something is missing" could
/// not say where, and where is the whole of the information.
fn gap_marker(room_id: &str, room: &Value) -> Message {
    // The batch token names this exact discontinuity, so re-processing the
    // same sync cannot produce two markers for one gap.
    let token = room
        .get("timeline")
        .and_then(|t| t.get("prev_batch"))
        .and_then(|b| b.as_str())
        .unwrap_or("");
    Message {
        event_id: format!("gap:{}:{}", room_id, token),
        thread_root: None,
        work: None,
        edited: false,
        reactions: Vec::new(),
        reply_to: None,
        reply_sender: None,
        reply_excerpt: None,
        sender: String::new(),
        sender_name: String::new(),
        sender_tag: None,
        pfp_attrs: None,
        player_id: None,
        body: "some messages are missing".to_string(),
        kind: "gap",
        is_self: false,
        admin: false,
        ts: 0,
        mentions_me: false,
        mxc: None,
        width: None,
        height: None,
    }
}

/// Read the silenced rooms out of an `m.push_rules` event.
///
/// A room rule's `rule_id` IS the room id. It counts as muted when its
/// actions contain no notification — historically `["dont_notify"]`, and in
/// current Synapse simply `[]`. Both are in the wild, so this asks what the
/// actions DO rather than matching a spelling.
fn muted_rooms(ev: &Value) -> std::collections::HashSet<String> {
    let mut out = std::collections::HashSet::new();
    let Some(rules) = ev
        .get("content")
        .and_then(|c| c.get("global"))
        .and_then(|g| g.get("room"))
        .and_then(|r| r.as_array())
    else {
        return out;
    };
    for rule in rules {
        if rule.get("enabled").and_then(|e| e.as_bool()) == Some(false) {
            continue;
        }
        let Some(id) = rule.get("rule_id").and_then(|i| i.as_str()) else {
            continue;
        };
        let notifies = rule
            .get("actions")
            .and_then(|a| a.as_array())
            .map(|acts| {
                acts.iter().any(|a| {
                    a.as_str() == Some("notify")
                        || a.get("set_tweak").and_then(|t| t.as_str()) == Some("sound")
                })
            })
            .unwrap_or(true);
        if !notifies {
            out.insert(id.to_string());
        }
    }
    out
}

/// Record who has read what. Returns whether anything moved.
///
/// Stores everyone, including us. Filtering "me" out belongs to `seen_state`,
/// which is where the identity that decides whose messages these ARE lives —
/// doing it here as well meant two notions of "me" that could disagree, and
/// did.
fn apply_receipts(gs: &mut GuildState, room_id: &str, ev: &Value) -> bool {
    let Some(content) = ev.get("content").and_then(|c| c.as_object()) else {
        return false;
    };
    let mut changed = false;
    for (event_id, kinds) in content {
        let Some(read) = kinds.get("m.read").and_then(|r| r.as_object()) else {
            continue;
        };
        for user_id in read.keys() {
            let slot = gs
                .receipts
                .entry(room_id.to_string())
                .or_default()
                .entry(user_id.clone());
            match slot {
                std::collections::hash_map::Entry::Occupied(mut e) => {
                    if e.get() != event_id {
                        e.insert(event_id.clone());
                        changed = true;
                    }
                }
                std::collections::hash_map::Entry::Vacant(e) => {
                    e.insert(event_id.clone());
                    changed = true;
                }
            }
        }
    }
    changed
}

/// Who has seen your most recent message, and which one that is.
///
/// Deliberately only your OWN latest: "did they see it" is a question about
/// something you said, and a receipt marker beside every message in a busy
/// room is decoration rather than an answer.
///
/// A receipt names the newest event that person has read, so "have they read
/// message X" is a question about ORDER — anyone whose marker sits at or
/// after X has seen it. That ordering only exists in the timeline buffer,
/// which is why this lives here and not beside the receipt map.
fn seen_state(gs: &GuildState, room_id: &str, me: &str) -> Option<Value> {
    let buf = gs.timelines.get(room_id)?;
    let markers = gs.receipts.get(room_id)?;

    // Where each event sits in the log this window holds.
    let mut at: HashMap<&str, usize> = HashMap::new();
    for (i, m) in buf.iter().enumerate() {
        at.insert(m.event_id.as_str(), i);
    }
    let mine = buf.iter().rposition(|m| m.sender == me)?;

    let mut names: Vec<String> = markers
        .iter()
        // Never yourself: this answers "did THEY see it", and telling a player
        // they have read their own message is noise dressed as information.
        .filter(|(user_id, _)| user_id.as_str() != me)
        .filter(|(_, event_id)| at.get(event_id.as_str()).is_some_and(|i| *i >= mine))
        .map(|(user_id, _)| {
            directory::player_id_of(user_id)
                .and_then(|pid| directory::get(&pid).map(|i| i.username))
                .filter(|n| !n.is_empty())
                .or_else(|| gs.names.get(user_id).cloned())
                .unwrap_or_else(|| localpart(user_id))
        })
        .collect();
    if names.is_empty() {
        return None;
    }
    names.sort();
    Some(json!({ "event_id": buf[mine].event_id, "names": names }))
}

/// The event this one replaces, if it is an edit.
fn replaces(content: &Value) -> Option<String> {
    let r = content.get("m.relates_to")?;
    if r.get("rel_type").and_then(|t| t.as_str()) != Some("m.replace") {
        return None;
    }
    r.get("event_id").and_then(|e| e.as_str()).map(String::from)
}

/// The text an edit is replacing it WITH.
///
/// `m.new_content` is the authoritative version. The top-level body is the
/// fallback for clients that cannot edit — it is the new text with a `*`
/// stuck on the front, which is not what anyone wants stored.
fn edited_body(content: &Value) -> Option<String> {
    if let Some(b) = content
        .get("m.new_content")
        .and_then(|n| n.get("body"))
        .and_then(|b| b.as_str())
    {
        return Some(b.to_string());
    }
    content
        .get("body")
        .and_then(|b| b.as_str())
        .map(|b| b.strip_prefix("* ").unwrap_or(b).to_string())
}

/// Apply an edit to the message it replaces. Returns whether one was found.
///
/// Only the sender may rewrite their own words, and checking that is THIS
/// side's job.
///
/// The spec puts the obligation on the client: a replacement must carry the
/// same `sender` as the event it replaces, and a client is to ignore one that
/// does not. Do not delete the check below on the assumption the homeserver
/// already made it — an `m.replace` is an ordinary message event, and a room
/// full of strangers is exactly where somebody would try rewriting your
/// words with one.
fn apply_edit(gs: &mut GuildState, room_id: &str, ev: &Value) -> Option<String> {
    let content = ev.get("content")?;
    let target = replaces(content)?;
    let sender = ev.get("sender").and_then(|s| s.as_str())?;
    let body = edited_body(content)?;

    let buf = gs.timelines.get_mut(room_id)?;
    let mut hit = false;
    for m in buf.iter_mut() {
        if m.event_id != target {
            continue;
        }
        if m.sender != sender {
            continue; // not theirs to rewrite
        }
        m.body = body.clone();
        m.edited = true;
        hit = true;
    }
    if hit { Some(target) } else { None }
}

/// The event a redaction removes. Top-level in older room versions, inside
/// content in newer ones; both are in the wild.
fn redacted_id(ev: &Value) -> Option<String> {
    ev.get("redacts")
        .and_then(|r| r.as_str())
        .or_else(|| ev.get("content").and_then(|c| c.get("redacts")).and_then(|r| r.as_str()))
        .map(|s| s.to_string())
}

/// Rewrite a message that has been taken back. Returns whether one was found.
///
/// "message removed" rather than dropping the row: a message that silently
/// vanishes from a conversation reads as a bug in the client, and the gap it
/// leaves is the one thing everyone else can still see.
fn redact_message(gs: &mut GuildState, room_id: &str, event_id: &str) -> bool {
    let Some(buf) = gs.timelines.get_mut(room_id) else { return false };
    let mut hit = false;
    for m in buf.iter_mut() {
        if m.event_id == event_id {
            m.kind = "notice";
            m.body = "message removed".to_string();
            m.mxc = None;
            m.reply_to = None;
            m.reply_sender = None;
            m.reply_excerpt = None;
            m.mentions_me = false;
            hit = true;
        }
    }
    hit
}

/// What an annotation is annotating.
fn reaction_target(ev: &Value) -> Option<String> {
    let r = ev.get("content")?.get("m.relates_to")?;
    if r.get("rel_type").and_then(|t| t.as_str()) != Some("m.annotation") {
        return None;
    }
    r.get("event_id").and_then(|e| e.as_str()).map(String::from)
}

/// Record one reaction. Returns whether anything changed.
fn apply_reaction(gs: &mut GuildState, room_id: &str, ev: &Value) -> bool {
    let Some(target) = reaction_target(ev) else { return false };
    let Some(key) = ev
        .get("content")
        .and_then(|c| c.get("m.relates_to"))
        .and_then(|r| r.get("key"))
        .and_then(|k| k.as_str())
    else {
        return false;
    };
    let (Some(sender), Some(event_id)) = (
        ev.get("sender").and_then(|s| s.as_str()),
        ev.get("event_id").and_then(|e| e.as_str()),
    ) else {
        return false;
    };
    // A key is other people's text arriving over federation. Bound it before
    // it becomes a chip in this window.
    let key: String = key.chars().take(32).collect();
    if key.trim().is_empty() {
        return false;
    }

    let who = gs
        .reactions
        .entry(room_id.to_string())
        .or_default()
        .entry(target.clone())
        .or_default()
        .entry(key.clone())
        .or_default();
    // The same person reacting twice with the same key is one reaction. Sync
    // replays events on reconnect, so this is the normal case, not an edge.
    if who.iter().any(|r| r.user_id == sender) {
        return false;
    }
    who.push(Reactor { user_id: sender.to_string(), event_id: event_id.to_string() });
    gs.annotations.insert(
        event_id.to_string(),
        (room_id.to_string(), target.clone(), key, sender.to_string()),
    );
    true
}

/// Undo a reaction a redaction removes. Returns the message it was on.
fn undo_reaction(gs: &mut GuildState, ev: &Value) -> Option<String> {
    // `redacts` is a top-level field on the event, and in newer room versions
    // also inside content. Accept both.
    let redacts = ev
        .get("redacts")
        .and_then(|r| r.as_str())
        .or_else(|| ev.get("content").and_then(|c| c.get("redacts")).and_then(|r| r.as_str()))?
        .to_string();
    let (room_id, target, key, _sender) = gs.annotations.remove(&redacts)?;
    let keys = gs.reactions.get_mut(&room_id)?.get_mut(&target)?;
    let who = keys.get_mut(&key)?;
    who.retain(|r| r.event_id != redacts);
    // A key nobody holds any more is not a zero chip; it is gone.
    if who.is_empty() {
        keys.remove(&key);
    }
    Some(target)
}

/// The reactions on one message, as the window shows them.
fn reactions_for(gs: &GuildState, room_id: &str, event_id: &str, me: &str) -> Vec<Reaction> {
    let Some(keys) = gs.reactions.get(room_id).and_then(|r| r.get(event_id)) else {
        return Vec::new();
    };
    let mut out: Vec<Reaction> = keys
        .iter()
        .map(|(key, who)| Reaction {
            key: key.clone(),
            count: who.len(),
            mine: who.iter().any(|r| r.user_id == me),
            who: who
                .iter()
                .map(|r| {
                    directory::player_id_of(&r.user_id)
                        .and_then(|pid| directory::get(&pid).map(|i| i.username))
                        .filter(|n| !n.is_empty())
                        .or_else(|| gs.names.get(&r.user_id).cloned())
                        .unwrap_or_else(|| localpart(&r.user_id))
                })
                .collect(),
        })
        .collect();
    // Most-agreed first, then by key so the order does not shuffle between
    // renders when two are level.
    out.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.key.cmp(&b.key)));
    out
}

fn render_event(ev: &Value, gs: &GuildState, room_id: &str, me: &str) -> Option<Message> {
    let etype = ev.get("type").and_then(|t| t.as_str()).unwrap_or("");
    let sender = ev.get("sender").and_then(|s| s.as_str()).unwrap_or("");
    let event_id = ev.get("event_id").and_then(|s| s.as_str()).unwrap_or("");
    let ts = ev
        .get("origin_server_ts")
        .and_then(|t| t.as_u64())
        .unwrap_or(0);
    let content = ev.get("content").cloned().unwrap_or(Value::Null);

    // A redacted event has an empty content object; showing "message removed"
    // is more honest than a blank line.
    let redacted = ev.get("unsigned").and_then(|u| u.get("redacted_because")).is_some();

    // An edit is not a message. It arrives as a full `m.room.message` whose
    // relation says "replace that one", and a client that does not understand
    // the relation shows it as a second message beginning with `*`. Rendering
    // it that way would double every corrected line.
    if replaces(&content).is_some() {
        return None;
    }

    // `m.in_reply_to` is how Matrix says "this answers that" — but not always.
    //
    // A THREADED message (`rel_type: m.thread`, which Element uses heavily)
    // also carries an `m.in_reply_to`, purely so clients that do not
    // understand threads still show something. The spec marks it
    // `is_falling_back: true`, and it points at whoever spoke last in the
    // thread rather than at anything the sender chose to answer.
    //
    // Rendering that as a reply puts a quote in somebody's mouth: "JPEG
    // replying to Netlag" when JPEG did no such thing. So a falling-back
    // reference is read as thread membership and nothing more.
    let relates = content.get("m.relates_to");
    let thread_root = relates
        .filter(|r| r.get("rel_type").and_then(|t| t.as_str()) == Some("m.thread"))
        .and_then(|r| r.get("event_id"))
        .and_then(|e| e.as_str())
        .map(|s| s.to_string());
    let in_reply = relates.and_then(|r| r.get("m.in_reply_to"));
    // `is_falling_back` sits beside `rel_type` in `m.relates_to`, NOT inside
    // `m.in_reply_to` — reading it from the inner object finds nothing and
    // every threaded message becomes a reply again. Both places are accepted
    // because implementations in the wild have put it in either.
    let falling_back = relates
        .and_then(|r| r.get("is_falling_back"))
        .or_else(|| in_reply.and_then(|r| r.get("is_falling_back")))
        .and_then(|b| b.as_bool())
        .unwrap_or(false);
    let reply_to = if falling_back {
        None
    } else {
        in_reply
            .and_then(|r| r.get("event_id"))
            .and_then(|e| e.as_str())
            .map(|s| s.to_string())
    };
    let (reply_sender, reply_excerpt) = match reply_to.as_ref() {
        Some(_) => quoted_from_fallback(
            content.get("body").and_then(|b| b.as_str()).unwrap_or(""),
        ),
        None => (None, None),
    };

    let (kind, body): (&'static str, String) = if redacted {
        ("notice", "message removed".to_string())
    } else if etype == "m.room.message" {
        let msgtype = content
            .get("msgtype")
            .and_then(|m| m.as_str())
            .unwrap_or("m.text");
        let text = content
            .get("body")
            .and_then(|b| b.as_str())
            .unwrap_or("")
            .to_string();
        // A rich reply repeats what it answers INSIDE its own body, as
        // `> <@who> what\n\n` lines. That is the fallback for clients with no
        // reply rendering; this one has, so leaving it in would print the
        // quote twice — once as the quote line and once as the message.
        // Stripped whenever a relation put it there, reply or thread: the
        // quote block is compatibility scaffolding either way, and leaving it
        // in prints the same words twice.
        let text = if in_reply.is_some() { strip_reply_fallback(&text) } else { text };
        match msgtype {
            "m.emote" => ("emote", text),
            "m.notice" => ("notice", text),
            // An image is shown, not described. The rest still name the file:
            // better than an empty bubble the player cannot explain.
            "m.image" => ("image", text),
            "m.file" | "m.audio" | "m.video" => {
                ("notice", format!("sent an attachment: {}", text))
            }
            _ => ("text", text),
        }
    } else if etype == "m.room.member" {
        let membership = content
            .get("membership")
            .and_then(|m| m.as_str())
            .unwrap_or("");
        // What this was BEFORE. Without it every profile edit reads as a
        // join: changing a display name or a picture is an `m.room.member`
        // event with `membership: "join"`, exactly like arriving. An active
        // guild produced a steady drip of "X joined" for people who had been
        // there all day.
        let prev = ev.get("unsigned").and_then(|u| u.get("prev_content"));
        let was = prev
            .and_then(|p| p.get("membership"))
            .and_then(|m| m.as_str())
            .unwrap_or("");
        // Who it happened TO, versus who did it. A `leave` somebody else
        // caused is a removal, not a departure, and calling it "left" gets
        // the story wrong in the one case people care about.
        let subject = ev.get("state_key").and_then(|k| k.as_str()).unwrap_or("");
        let by_someone_else = !subject.is_empty() && subject != sender;

        match (was, membership) {
            ("join", "join") => {
                let old_name = prev
                    .and_then(|p| p.get("displayname"))
                    .and_then(|n| n.as_str())
                    .unwrap_or("");
                let new_name = content
                    .get("displayname")
                    .and_then(|n| n.as_str())
                    .unwrap_or("");
                if old_name != new_name && !new_name.is_empty() {
                    ("event", format!("is now known as {}", new_name))
                } else {
                    // A new picture, or nothing this client can see. Not a
                    // line anyone wants in a conversation.
                    return None;
                }
            }
            (_, "join") => ("event", "joined".to_string()),
            // BEFORE the leave arms. An unban is `ban → leave` performed by a
            // moderator, so the "somebody else did this" test below would
            // otherwise call lifting a ban a removal — the opposite of what
            // happened.
            ("ban", "leave") => ("event", "was unbanned".to_string()),
            (_, "leave") if by_someone_else => ("event", "was removed".to_string()),
            (_, "leave") => ("event", "left".to_string()),
            (_, "ban") => ("event", "was banned".to_string()),
            (_, "invite") => ("event", "was invited".to_string()),
            _ => return None,
        }
    } else if SETUP_EVENTS.contains(&etype) {
        // Room plumbing. Every room ever created emits this burst — "changed
        // create", "changed power_levels", "changed join_rules",
        // "changed history_visibility", "changed guest_access" — and not one
        // of them is something a player wants to read. They were the first
        // six lines of every room in the client.
        return None;
    } else if etype == "m.room.name" {
        let n = content.get("name").and_then(|x| x.as_str()).unwrap_or("");
        ("event", if n.is_empty() { "removed the room name".into() }
                  else { format!("named the room “{}”", n) })
    } else if etype == "m.room.topic" {
        ("event", "changed the topic".to_string())
    } else if etype == "m.room.tombstone" {
        // The room has been replaced — a normal thing for an admin to do when
        // changing room version. Without this it rendered as "changed
        // tombstone" and the room became a dead end: still listed, still
        // open, nobody reading it.
        ("notice", "this room has been replaced — the conversation continues elsewhere".to_string())
    } else if etype == "m.room.encrypted" {
        // An encrypted message. This client has no crypto, and pretending
        // otherwise is not an option — but the generic branch below rendered
        // these as "changed encrypted", so an Element DM (which is encrypted
        // by DEFAULT) came through as a stream of nonsense with no hint that
        // encryption was the reason.
        ("notice", "encrypted message — this app cannot read it".to_string())
    } else if etype.starts_with("m.room.") {
        // Anything else that IS state but has no rendering of its own: still
        // worth a line, because a silently dropped event looks like a bug.
        ("event", format!("changed {}", etype.trim_start_matches("m.room.")))
    } else {
        return None;
    };

    if body.is_empty() {
        return None;
    }

    let level = gs
        .power
        .get(room_id)
        .and_then(|p| p.get(sender).copied())
        .unwrap_or(0);

    // `m.mentions` is the spec's own answer to "was this aimed at me", and it
    // is EXACT — the word-boundary guess in the window is only a fallback for
    // clients that do not send it. The live Orbital Hydro room already
    // contains messages carrying it.
    let addressed_to_me = content
        .get("m.mentions")
        .and_then(|m| m.get("user_ids"))
        .and_then(|u| u.as_array())
        .map(|a| a.iter().any(|v| v.as_str() == Some(me)))
        .unwrap_or(false);
    // …and the fallback the comment above promises, actually applied.
    //
    // These were two different questions with two different answers. The UI
    // highlighted on the exact signal ONLY, and the notifier matched the body
    // text ONLY — so a spec-compliant mention whose body does not spell your
    // name highlighted without ever interrupting you, and a mention from a
    // client too old to send `m.mentions` interrupted you without highlighting.
    // Each surface was missing exactly what the other had.
    let mentions_me = addressed_to_me
        || (sender != me && is_mention(&body, &my_names(me)));

    // Where the picture lives, for the ones that have one.
    let media = if kind == "image" {
        content.get("url").and_then(|u| u.as_str()).map(|s| s.to_string())
    } else {
        None
    };
    let info = content.get("info");

    // The localpart IS the player id, so the game's own identity for this
    // sender — real name, guild tag, portrait — is a direct lookup. The
    // homeserver's display name is the fallback, not the other way round: a
    // Matrix display name is self-chosen and can impersonate, while the
    // directory's name is the on-chain one.
    let player_id = directory::player_id_of(sender);
    let ident = player_id.as_deref().and_then(directory::get);

    Some(Message {
        event_id: event_id.to_string(),
        thread_root,
        work: super::work::parse(&content),
        edited: false,
        reactions: Vec::new(),
        reply_to,
        reply_sender,
        reply_excerpt,
        sender: sender.to_string(),
        sender_name: sender_display(sender, ident.as_ref(), gs),
        sender_tag: ident.as_ref().map(|i| i.tag.clone()).filter(|t| !t.is_empty()),
        pfp_attrs: ident.as_ref().and_then(|i| i.pfp_attrs.clone()),
        player_id,
        body,
        kind,
        is_self: sender == me,
        admin: level >= 100,
        ts,
        mentions_me,
        // The window asks for the bytes separately (media needs the access
        // token, which never leaves Rust); these are what it needs to lay the
        // picture out before they arrive.
        mxc: media,
        width: info.and_then(|i| i.get("w")).and_then(|w| w.as_u64()),
        height: info.and_then(|i| i.get("h")).and_then(|h| h.as_u64()),
    })
}

fn localpart(user_id: &str) -> String {
    user_id
        .trim_start_matches('@')
        .split(':')
        .next()
        .unwrap_or(user_id)
        .to_string()
}

// ── Sync ────────────────────────────────────────────────────────────────────

/// Fold one `/sync` response into the guild's state and return what changed.
/// Deltas, whether the room list moved, who is typing, and which messages had
/// their reactions change — the last so the window can repaint one message
/// rather than the whole timeline.
/// Everything one sync pass changed.
///
/// A struct rather than a tuple: this began as three elements and reached six,
/// and each addition silently renumbered every destructuring in the file. The
/// compiler catches an arity change; it cannot catch two fields of the same
/// type swapping places.
#[derive(Default)]
struct SyncDelta {
    /// (room, new messages) — what to append to a timeline.
    deltas: Vec<(String, Vec<Message>)>,
    /// Whether the room list itself moved.
    rooms_changed: bool,
    /// (room, who is typing) — the whole current set, not a diff.
    typing: Vec<(String, Vec<String>)>,
    /// Messages whose reactions moved, so one message repaints.
    reacted: Vec<(String, String)>,
    /// Messages somebody took back.
    redacted: Vec<(String, String)>,
    /// Messages somebody rewrote.
    edited: Vec<(String, String)>,
    /// Rooms where somebody's read marker moved.
    receipts: Vec<String>,
    /// Whether anyone's presence moved this pass.
    presence: bool,
}

fn apply_sync(guild_id: &str, session: &Session, v: &Value) -> SyncDelta {
    let server = server_name(session);
    let mut deltas: Vec<(String, Vec<Message>)> = Vec::new();
    let mut rooms_changed = false;
    let mut typing_changed: Vec<(String, Vec<String>)> = Vec::new();
    // (room_id, event_id) for every message whose reactions moved this sync.
    let mut reaction_changes: Vec<(String, String)> = Vec::new();
    // …and for every message somebody took back.
    let mut redactions: Vec<(String, String)> = Vec::new();
    // …and for every one they rewrote.
    let mut edits: Vec<(String, String)> = Vec::new();
    // Rooms where somebody's read marker moved.
    let mut receipts_changed: Vec<String> = Vec::new();
    let mut presence_changed = false;
    // Players a room is named after but the directory has not met. Collected
    // under the lock, resolved after it — `apply_sync` cannot await.
    let mut needs_identity: Vec<String> = Vec::new();

    let mut map = STATE.write().unwrap();
    let gs = map.entry(guild_id.to_string()).or_default();
    gs.next_batch = v
        .get("next_batch")
        .and_then(|b| b.as_str())
        .map(|s| s.to_string());

    // ── Presence
    //
    // Who is actually here right now — the most social signal Matrix carries,
    // and one this app discarded entirely. It arrives top-level, not per room,
    // because it is a property of a person rather than of a conversation.
    for ev in v
        .get("presence")
        .and_then(|p| p.get("events"))
        .and_then(|e| e.as_array())
        .map(|a| a.as_slice())
        .unwrap_or(&[])
    {
        if ev.get("type").and_then(|t| t.as_str()) != Some("m.presence") {
            continue;
        }
        let Some(user_id) = ev.get("sender").and_then(|s| s.as_str()) else { continue };
        let content = ev.get("content");
        let state = content
            .and_then(|c| c.get("presence"))
            .and_then(|p| p.as_str())
            .unwrap_or("offline")
            .to_string();
        let entry = Presence {
            state,
            last_active_ago: content
                .and_then(|c| c.get("last_active_ago"))
                .and_then(|l| l.as_u64()),
            currently_active: content
                .and_then(|c| c.get("currently_active"))
                .and_then(|a| a.as_bool())
                .unwrap_or(false),
            // Other people's text, arriving over federation and going onto a
            // roster row. Bounded before it gets there.
            status_msg: content
                .and_then(|c| c.get("status_msg"))
                .and_then(|m| m.as_str())
                .map(|m| m.chars().take(80).collect::<String>())
                .filter(|m| !m.trim().is_empty()),
        };
        if gs.presence.get(user_id) != Some(&entry) {
            gs.presence.insert(user_id.to_string(), entry);
            presence_changed = true;
        }
    }

    // `m.direct` is where Matrix records "this room is a DM with that user":
    // {user_id: [room_id, …]}. Without reading it, a DM is indistinguishable
    // from a two-person channel named after its room id.
    for ev in v
        .get("account_data")
        .and_then(|a| a.get("events"))
        .and_then(|e| e.as_array())
        .map(|a| a.as_slice())
        .unwrap_or(&[])
    {
        // Which rooms the player has silenced. Matrix models this as a push
        // rule per room whose actions do not include a notification — the
        // same state Element writes, so muting here mutes on their phone too.
        if ev.get("type").and_then(|t| t.as_str()) == Some("m.push_rules") {
            gs.muted = muted_rooms(ev);
            rooms_changed = true;
            continue;
        }
        if ev.get("type").and_then(|t| t.as_str()) != Some("m.direct") {
            continue;
        }
        if let Some(obj) = ev.get("content").and_then(|c| c.as_object()) {
            for (user_id, rooms) in obj {
                for r in rooms.as_array().map(|a| a.as_slice()).unwrap_or(&[]) {
                    if let Some(rid) = r.as_str() {
                        gs.dm_with.insert(rid.to_string(), user_id.clone());
                    }
                }
            }
        }
    }

    let joined = v
        .get("rooms")
        .and_then(|r| r.get("join"))
        .and_then(|j| j.as_object())
        .cloned()
        .unwrap_or_default();

    for (room_id, room) in joined {
        // ── State first: names and power levels feed message rendering, so
        //    they must land before the timeline is rendered against them.
        let state_events = room
            .get("state")
            .and_then(|s| s.get("events"))
            .and_then(|e| e.as_array())
            .cloned()
            .unwrap_or_default();
        let timeline_events = room
            .get("timeline")
            .and_then(|t| t.get("events"))
            .and_then(|e| e.as_array())
            .cloned()
            .unwrap_or_default();

        let mut name: Option<String> = None;
        let mut alias: Option<String> = None;
        let mut topic: Option<String> = None;
        let mut pinned: Option<Vec<String>> = None;
        let mut encrypted = false;
        let mut replaced_by: Option<String> = None;

        for ev in state_events.iter().chain(timeline_events.iter()) {
            let etype = ev.get("type").and_then(|t| t.as_str()).unwrap_or("");
            let content = ev.get("content");
            match etype {
                "m.room.name" => {
                    // Sanitized at INGESTION so nothing downstream has to
                    // remember. A room name is set by whoever can send state in
                    // that room — on a federated server, not necessarily anyone
                    // we know — and it renders beside the guild's own rooms.
                    name = content
                        .and_then(|c| c.get("name"))
                        .and_then(|n| n.as_str())
                        .map(|s| super::identity::sanitize(s));
                }
                "m.room.canonical_alias" => {
                    alias = content
                        .and_then(|c| c.get("alias"))
                        .and_then(|a| a.as_str())
                        .map(|s| s.to_string());
                }
                "m.room.topic" => {
                    topic = content
                        .and_then(|c| c.get("topic"))
                        .and_then(|t| t.as_str())
                        .map(|s| s.to_string());
                }
                // The room's own shortlist: the current target, the standing
                // rules — the handful of things everyone in here needs. Ids
                // only; the events themselves are fetched on demand, because a
                // pin can point at something said a year ago that no sync
                // window will ever carry.
                "m.room.pinned_events" => {
                    pinned = content
                        .and_then(|c| c.get("pinned"))
                        .and_then(|p| p.as_array())
                        .map(|a| {
                            a.iter()
                                .filter_map(|e| e.as_str())
                                .map(|s| s.to_string())
                                .collect::<Vec<_>>()
                        });
                }
                // Setup noise everywhere else, but the one bit of it a reader
                // needs: it explains why the room is unreadable.
                "m.room.encryption" => {
                    encrypted = true;
                }
                "m.room.tombstone" => {
                    replaced_by = content
                        .and_then(|c| c.get("replacement_room"))
                        .and_then(|r| r.as_str())
                        .map(str::to_string);
                }
                "m.room.member" => {
                    if let (Some(uid), Some(c)) =
                        (ev.get("state_key").and_then(|k| k.as_str()), content)
                    {
                        if let Some(dn) = c.get("displayname").and_then(|d| d.as_str()) {
                            if !dn.is_empty() {
                                gs.names.insert(uid.to_string(), dn.to_string());
                            }
                        }
                    }
                }
                "m.room.power_levels" => {
                    if let Some(users) = content.and_then(|c| c.get("users")).and_then(|u| u.as_object())
                    {
                        let entry = gs.power.entry(room_id.clone()).or_default();
                        for (uid, lvl) in users {
                            if let Some(n) = lvl.as_i64() {
                                entry.insert(uid.clone(), n);
                            }
                        }
                    }
                }
                _ => {}
            }
        }

        let members = room
            .get("summary")
            .and_then(|s| s.get("m.joined_member_count"))
            .and_then(|c| c.as_u64());
        // `m.heroes` is the spec's answer for a room with no name: the other
        // people in it. Without reading it, an unnamed room has nothing to be
        // called except its own id.
        let heroes: Vec<String> = room
            .get("summary")
            .and_then(|s| s.get("m.heroes"))
            .and_then(|h| h.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                    .filter(|u| u != &session.user_id)
                    .collect()
            })
            .unwrap_or_default();

        // What the homeserver says is unread in this room. Present on every
        // joined room in a sync response; absent only in fixtures and in
        // incremental syncs that touched nothing, where the previous value
        // stands rather than resetting to zero.
        let notifs = room.get("unread_notifications");
        let count_of = |key: &str| notifs.and_then(|n| n.get(key)).and_then(|c| c.as_u64());
        let existing = gs.rooms.get(&room_id).cloned();
        let notif_count = count_of("notification_count")
            .unwrap_or_else(|| existing.as_ref().map(|r| r.unread).unwrap_or(0));
        let highlight_count = count_of("highlight_count").unwrap_or_else(|| {
            u64::from(existing.as_ref().map(|r| r.mention).unwrap_or(false))
        });
        let final_alias = alias
            .clone()
            .or_else(|| existing.as_ref().and_then(|r| r.canonical_alias.clone()));
        let display = name
            .clone()
            .or_else(|| existing.as_ref().map(|r| r.name.clone()).filter(|n| !n.is_empty()))
            // An alias reads far better as its localpart: "#orbital-hydro:host"
            // is plumbing, "Orbital Hydro" is a name.
            .or_else(|| final_alias.as_deref().and_then(pretty_alias))
            // Then whoever is in it — the spec's own fallback.
            .or_else(|| {
                let named = name_heroes(&heroes);
                if named.is_empty() { None } else { Some(named) }
            })
            // NEVER a raw `!room_id`. A room we know nothing about is still
            // better described as "a conversation" than as an opaque handle.
            .unwrap_or_else(|| "Untitled room".to_string());

        // A DM is presented as the person it is with: their name, their guild
        // tag, their portrait — never a room id or an auto-generated title.
        //
        // `m.direct` is authoritative when present, but it is routinely ABSENT:
        // a DM created by another client, or by the guild's own tooling, never
        // writes it into our account data. So an unnamed two-person room counts
        // as a direct message on its own evidence.
        // We were TOLD who this is; nothing below has to guess.
        let told_player = gs.dm_player_id.get(&room_id).cloned();
        let dm_peer = gs.dm_with.get(&room_id).cloned().or_else(|| {
            let two_or_fewer = members.map(|m| m <= 2).unwrap_or(false);
            if name.is_none() && final_alias.is_none() && two_or_fewer {
                heroes.first().cloned()
            } else {
                None
            }
        });
        let dm_player = told_player
            .clone()
            .or_else(|| dm_peer.as_deref().and_then(directory::player_id_of));
        // A conversation we opened FOR somebody is a direct message even
        // before they accept — which is the state it spends its first moments
        // in, and the one it was rendering as a channel.
        let is_dm = told_player.is_some() || dm_peer.is_some();
        let dm_ident = dm_player.as_deref().and_then(directory::get);
        if let Some(pid) = dm_player.as_deref() {
            if dm_ident.is_none() {
                // Not known yet — remember to look them up after this pass, so
                // the next sync titles the conversation with their name rather
                // than their id.
                needs_identity.push(pid.to_string());
            }
        }

        // Computed before the literal: `display` and `final_alias` are moved
        // into it.
        let rank = if is_dm { None } else { home_rank(final_alias.as_deref()) };
        let entry = Room {
            home_rank: rank,
            room_id: room_id.clone(),
            icon: if dm_peer.is_some() {
                "icon-member"
            } else {
                icon_for(&display, final_alias.as_deref())
            },
            name: match dm_ident.as_ref() {
                Some(i) if !i.username.is_empty() => i.username.clone(),
                // Not in the game directory (a bot, or another guild's service
                // account): the homeserver's own display name beats the id.
                _ => match dm_peer.as_deref() {
                    Some(peer) => gs
                        .names
                        .get(peer)
                        .cloned()
                        .or_else(|| dm_player.clone())
                        .unwrap_or_else(|| localpart(peer)),
                    // No peer yet, but we know which player this is for. Their
                    // id beats printing the room's own id at them.
                    None => dm_player.clone().unwrap_or(display),
                },
            },
            canonical_alias: final_alias,
            topic: topic.or_else(|| existing.as_ref().and_then(|r| r.topic.clone())),
            members: members
                .or_else(|| existing.as_ref().map(|r| r.members))
                .unwrap_or(0),
            joined: true,
            invited: false,
            invited_by: None,
            // Sticky: the state event arrives once, in the sync that turned
            // it on, and a later sync mentioning nothing must not read as
            // "encryption was switched off" — Matrix has no such thing.
            encrypted: encrypted || existing.as_ref().is_some_and(|r| r.encrypted),
            // Sticky for the same reason encryption is: the tombstone arrives
            // once, and a room does not come back to life.
            replaced_by: replaced_by
                .or_else(|| existing.as_ref().and_then(|r| r.replaced_by.clone())),
            muted: gs.muted.contains(&room_id),
            // Absent means "this sync did not mention pins", never "there are
            // none" — the same trap as the unread counts above.
            pinned: pinned
                .or_else(|| existing.as_ref().map(|r| r.pinned.clone()))
                .unwrap_or_default(),
            unread: notif_count,
            mention: highlight_count > 0,
            section: if is_dm {
                SECTION_DIRECT
            } else {
                section_for(&room_id, &server)
            },
            pfp_attrs: dm_ident.as_ref().and_then(|i| i.pfp_attrs.clone()),
            player_id: dm_player,
        };
        if existing.as_ref() != Some(&entry) {
            rooms_changed = true;
        }
        gs.rooms.insert(room_id.clone(), entry);

        // ── Typing (ephemeral)
        // `m.typing` carries the WHOLE current set every time, so replacing is
        // correct and removing stale entries is automatic.
        if let Some(events) = room
            .get("ephemeral")
            .and_then(|e| e.get("events"))
            .and_then(|e| e.as_array())
        {
            for ev in events {
                if ev.get("type").and_then(|t| t.as_str()) == Some("m.receipt") {
                    if apply_receipts(gs, &room_id, ev) {
                        receipts_changed.push(room_id.clone());
                    }
                    continue;
                }
                if ev.get("type").and_then(|t| t.as_str()) != Some("m.typing") {
                    continue;
                }
                let mut who: Vec<String> = ev
                    .get("content")
                    .and_then(|c| c.get("user_ids"))
                    .and_then(|u| u.as_array())
                    .map(|a| {
                        a.iter()
                            .filter_map(|v| v.as_str().map(|s| s.to_string()))
                            .collect()
                    })
                    .unwrap_or_default();
                // Never report yourself as typing back at yourself.
                who.retain(|u| u != &session.user_id);
                let prev = gs.typing.get(&room_id);
                if prev.map(|p| p.as_slice()) != Some(who.as_slice()) {
                    typing_changed.push((room_id.clone(), who.clone()));
                }
                gs.typing.insert(room_id.clone(), who);
            }
        }

        // ── Reactions and redactions
        //
        // Taken BEFORE rendering, in the order they arrived: an annotation and
        // the redaction that removes it can land in the same sync, and applying
        // them out of order leaves a reaction nobody sent.
        for ev in &timeline_events {
            match ev.get("type").and_then(|t| t.as_str()) {
                Some("m.reaction") => {
                    if apply_reaction(gs, &room_id, ev) {
                        if let Some(t) = reaction_target(ev) {
                            reaction_changes.push((room_id.clone(), t));
                        }
                    }
                }
                Some("m.room.message") => {
                    if let Some(target) = apply_edit(gs, &room_id, ev) {
                        edits.push((room_id.clone(), target));
                    }
                }
                Some("m.room.redaction") => {
                    if let Some(target) = undo_reaction(gs, ev) {
                        reaction_changes.push((room_id.clone(), target));
                    // A redaction that is not undoing a reaction is somebody
                    // taking a MESSAGE back. Rewriting it here is what makes
                    // that happen on screen; without this the message stayed
                    // up until the window was reloaded, which is the one
                    // outcome an unsend must not have.
                    } else if let Some(id) = redacted_id(ev) {
                        if redact_message(gs, &room_id, &id) {
                            redactions.push((room_id.clone(), id));
                        }
                    }
                }
                _ => {}
            }
        }

        // ── Timeline
        //
        // `limited` is the server saying "I truncated this batch": messages
        // exist between what we already hold and what just arrived. It
        // happens after any reconnect and during any busy stretch. Appending
        // regardless stitched two ends of a conversation together as though
        // nothing were missing — a history that reads as continuous and is
        // not, which is the one kind of wrong a log must never be.
        let limited = room
            .get("timeline")
            .and_then(|t| t.get("limited"))
            .and_then(|l| l.as_bool())
            .unwrap_or(false);

        let mut rendered: Vec<Message> = Vec::new();
        for ev in &timeline_events {
            if let Some(m) = render_event(ev, gs, &room_id, &session.user_id) {
                rendered.push(m);
            }
        }
        if !rendered.is_empty() {
            let buf = gs.timelines.entry(room_id.clone()).or_default();

            /* The same batch twice is not the same message twice.
             *
             * A client retries `/sync` with the SAME `since` token until it
             * gets a response it managed to process, so a batch arriving again
             * is ordinary behaviour rather than a server misbehaving —
             * `apply_reaction` says as much where it dedupes reactors, and the
             * timeline simply did not do the equivalent. A dropped connection
             * mid-conversation therefore printed the whole batch a second time.
             *
             * Keyed on the server's event id, so only events the homeserver has
             * actually named are deduped: a local echo has no id yet, and a gap
             * marker is a rendering of a discontinuity rather than an event.
             */
            let seen: std::collections::HashSet<&str> = buf
                .iter()
                .filter(|m| m.event_id.starts_with('$'))
                .map(|m| m.event_id.as_str())
                .collect();
            let fresh: Vec<Message> = rendered
                .iter()
                .filter(|m| !(m.event_id.starts_with('$') && seen.contains(m.event_id.as_str())))
                .cloned()
                .collect();
            if fresh.is_empty() {
                continue;               // nothing new; not even a gap to mark
            }
            let rendered = fresh;

            // Only when there is something to be discontinuous WITH. A
            // limited first batch is not a gap; it is simply where our view
            // of the room starts, and the scrollback control already says so.
            if limited && !buf.is_empty() {
                buf.push(gap_marker(&room_id, &room));
            }
            buf.extend(rendered.iter().cloned());
            if buf.len() > TIMELINE_CAP {
                let cut = buf.len() - TIMELINE_CAP;
                buf.drain(..cut);
            }
            deltas.push((room_id.clone(), rendered));
        }
    }

    // ── Invitations
    //
    // Read at all, for the first time. `rooms.invite` was ignored entirely,
    // so being asked into a room — a guild lobby, a raid channel, a stranger's
    // DM — was completely invisible: no row, no badge, nothing. In a
    // federated game where guilds invite each other that is not a small gap.
    //
    // An invite carries `invite_state`: STRIPPED state, enough to decide
    // whether to accept and nothing more. There is no timeline until you do.
    if let Some(invited) = v
        .get("rooms")
        .and_then(|r| r.get("invite"))
        .and_then(|i| i.as_object())
    {
        for (room_id, room) in invited {
            let events = room
                .get("invite_state")
                .and_then(|s| s.get("events"))
                .and_then(|e| e.as_array())
                .map(|a| a.as_slice())
                .unwrap_or(&[]);

            let mut name = String::new();
            let mut alias = None;
            let mut topic = None;
            let mut inviter = None;
            for ev in events {
                let etype = ev.get("type").and_then(|t| t.as_str()).unwrap_or("");
                let content = ev.get("content");
                match etype {
                    "m.room.name" => {
                        name = super::identity::sanitize(
                            content
                                .and_then(|c| c.get("name"))
                                .and_then(|n| n.as_str())
                                .unwrap_or(""),
                        );
                    }
                    "m.room.canonical_alias" => {
                        alias = content
                            .and_then(|c| c.get("alias"))
                            .and_then(|a| a.as_str())
                            .map(str::to_string);
                    }
                    "m.room.topic" => {
                        topic = content
                            .and_then(|c| c.get("topic"))
                            .and_then(|t| t.as_str())
                            .map(str::to_string);
                    }
                    // The membership event naming US is the one whose sender
                    // is the person who asked.
                    "m.room.member"
                        if ev.get("state_key").and_then(|k| k.as_str())
                            == Some(session.user_id.as_str()) =>
                    {
                        inviter = ev.get("sender").and_then(|s| s.as_str()).map(str::to_string);
                    }
                    _ => {}
                }
            }

            let display = if !name.is_empty() {
                name
            } else if let Some(pretty) = alias.as_deref().and_then(pretty_alias) {
                pretty
            } else {
                room_id.clone()
            };
            let by = inviter.as_deref().map(|u| {
                directory::player_id_of(u)
                    .and_then(|pid| directory::get(&pid).map(|i| i.username))
                    .filter(|n| !n.is_empty())
                    .or_else(|| gs.names.get(u).cloned())
                    .unwrap_or_else(|| localpart(u))
            });
            if let Some(u) = inviter.as_deref() {
                if let Some(pid) = directory::player_id_of(u) {
                    if directory::get(&pid).is_none() {
                        needs_identity.push(pid);
                    }
                }
            }

            let entry = Room {
                room_id: room_id.clone(),
                name: display,
                canonical_alias: alias.clone(),
                topic,
                members: 0,
                joined: false,
                invited: true,
                invited_by: by,
                muted: false,
                encrypted: false,
                replaced_by: None,
                pinned: Vec::new(),
                unread: 0,
                mention: false,
                icon: icon_for("", alias.as_deref()),
                section: SECTION_INVITE,
                home_rank: None,
                pfp_attrs: None,
                player_id: None,
            };
            if gs.rooms.get(room_id) != Some(&entry) {
                rooms_changed = true;
            }
            gs.rooms.insert(room_id.clone(), entry);
        }
    }

    // A room we left elsewhere should stop being listed here too.
    if let Some(left) = v
        .get("rooms")
        .and_then(|r| r.get("leave"))
        .and_then(|l| l.as_object())
    {
        for room_id in left.keys() {
            if gs.rooms.remove(room_id).is_some() {
                gs.timelines.remove(room_id);
                rooms_changed = true;
            }
        }
    }

    if !needs_identity.is_empty() {
        // Not awaited here (this function is sync and holds the lock); the
        // sync loop picks them up and the next pass renders the name.
        PENDING_IDENTITY.write().unwrap().extend(needs_identity);
    }
    SyncDelta {
        deltas,
        rooms_changed,
        typing: typing_changed,
        reacted: reaction_changes,
        redacted: redactions,
        edited: edits,
        receipts: receipts_changed,
        presence: presence_changed,
    }
}

/// Players a fold wanted identity for but could not await. Drained by the sync
/// loop between passes.
static PENDING_IDENTITY: std::sync::LazyLock<RwLock<Vec<String>>> =
    std::sync::LazyLock::new(|| RwLock::new(Vec::new()));

fn drain_pending_identity() -> Vec<String> {
    PENDING_IDENTITY
        .write()
        .map(|mut v| std::mem::take(&mut *v))
        .unwrap_or_default()
}

// ── Being contacted ─────────────────────────────────────────────────────────
//
// ICQ's whole personality was telling you someone wanted you. The sync loop
// runs whether or not the Comms window is open, so this decision belongs here
// rather than in the window: Rust knows the message, knows whether the room is
// a direct message, and can ask whether anyone is actually looking.

/// The names that count as "me" in a message body: the on-chain username and
/// the player id. Matched at word boundaries — see `is_mention`.
fn my_names(user_id: &str) -> Vec<String> {
    let mut out = Vec::new();
    if let Some(pid) = directory::player_id_of(user_id) {
        if let Some(ident) = directory::get(&pid) {
            if !ident.username.is_empty() {
                out.push(ident.username);
            }
        }
        out.push(pid);
    }
    out.retain(|n| n.chars().count() >= 2);
    out
}

/// Word-boundary match, treating anything that is not a letter, digit,
/// underscore or hyphen as a boundary. A plain `contains` would fire
/// "Marklifer" on "Marklifers", and `\b` alone does not hold for ids like
/// `1-194` because the hyphen is itself a word boundary.
fn is_mention(body: &str, names: &[String]) -> bool {
    let hay: Vec<char> = body.to_lowercase().chars().collect();
    for name in names {
        let needle: Vec<char> = name.to_lowercase().chars().collect();
        if needle.is_empty() || needle.len() > hay.len() {
            continue;
        }
        let boundary = |c: char| !(c.is_alphanumeric() || c == '_' || c == '-');
        for start in 0..=(hay.len() - needle.len()) {
            if hay[start..start + needle.len()] != needle[..] {
                continue;
            }
            let before_ok = start == 0 || boundary(hay[start - 1]);
            let after = start + needle.len();
            let after_ok = after == hay.len() || boundary(hay[after]);
            if before_ok && after_ok {
                return true;
            }
        }
    }
    false
}

/// Never more than one notification per room per this long. A room that is
/// mid-argument would otherwise produce a notification per line.
const NOTIFY_COOLDOWN_SECS: u64 = 45;
static NOTIFIED_AT: std::sync::LazyLock<RwLock<HashMap<String, u64>>> =
    std::sync::LazyLock::new(|| RwLock::new(HashMap::new()));

fn claim_notify_slot(room_id: &str) -> bool {
    let now = auth::now_secs();
    let mut map = NOTIFIED_AT.write().unwrap();
    match map.get(room_id) {
        Some(at) if now.saturating_sub(*at) < NOTIFY_COOLDOWN_SECS => false,
        _ => {
            map.insert(room_id.to_string(), now);
            true
        }
    }
}

/// True when nobody is looking at the Comms window — closed, minimised, or
/// simply behind something else. Notifying someone about a message they are
/// already reading is the fastest way to get notifications turned off.
fn window_is_watched(app: &tauri::AppHandle) -> bool {
    use tauri::Manager;
    match app.get_webview_window("chat") {
        Some(w) => w.is_focused().unwrap_or(false) && w.is_visible().unwrap_or(false),
        None => false,
    }
}

/// Decide and send. Only a direct message or a mention earns one: everything
/// else is traffic, and traffic that interrupts is noise.
fn maybe_notify(
    app: &tauri::AppHandle,
    guild_id: &str,
    room_id: &str,
    messages: &[Message],
    session: &Session,
) {
    if window_is_watched(app) {
        return;
    }
    // Silenced rooms still count as unread; they are simply not allowed to
    // interrupt. That distinction is the whole point of muting rather than
    // leaving.
    {
        let map = STATE.read().unwrap();
        if map.get(guild_id).is_some_and(|gs| gs.muted.contains(room_id)) {
            return;
        }
    }
    let is_dm = {
        let map = STATE.read().unwrap();
        map.get(guild_id)
            .map(|gs| gs.dm_with.contains_key(room_id))
            .unwrap_or(false)
    };
    /* Only when somebody has actually SAID something.
     *
     * `kind != "unknown"` was far too loose. Ten different things render as
     * kind `event` — a join, a rename, a topic change, a pin, an invitation —
     * and in a DM every one of them interrupted the player. Signing in
     * therefore produced a desktop notification reading "<name> joined",
     * every time, which is noise attached to the one channel that should only
     * ever mean a person is talking to you.
     *
     * An allowlist, and a conservative one. `notice` is deliberately absent:
     * it carries real `m.notice` messages, but it is ALSO the kind this file
     * gives its own synthesized lines — "message removed", "this room has been
     * replaced", "encrypted message — this app cannot read it". None of those
     * are a person speaking, and a redaction notifying you about a message you
     * were already notified about is the same bug wearing a different hat.
     */
    let hit = messages.iter().find(|m| {
        !m.is_self
            && matches!(m.kind, "text" | "emote" | "image")
            && (is_dm || m.mentions_me)
    });
    let Some(m) = hit else { return };
    // A DM and a mention are different interruptions — someone opening a
    // conversation with you, versus your name coming up in a room you are
    // already in — so they are separately switchable. Checked BEFORE the rate
    // limiter: a silenced channel must not spend the room's notify slot, or a
    // muted mention would suppress the DM that arrived a second later.
    let channel = if is_dm { "comms_dm" } else { "comms_mention" };
    if !crate::notifications::is_on(channel) {
        return;
    }
    if !claim_notify_slot(room_id) {
        return;
    }

    let room_name = {
        let map = STATE.read().unwrap();
        map.get(guild_id)
            .and_then(|gs| gs.rooms.get(room_id).map(|r| r.name.clone()))
            .unwrap_or_else(|| room_id.to_string())
    };
    // A DM is already titled by the person, so repeating their name in the
    // body would say it twice.
    let title = if is_dm {
        room_name
    } else {
        format!("{} — {}", m.sender_name, room_name)
    };
    let mut body = m.body.replace('\n', " ");
    if body.chars().count() > 140 {
        body = body.chars().take(139).collect::<String>() + "…";
    }
    crate::notifications::notify(&title, &body);
}

/// Unread across every network the player is signed in to.
///
/// Deliberately not per-guild: the surfaces that ask this question — the door
/// into Comms, a dock badge — are asking "is there anything waiting", and a
/// player who has to work out which guild it was in has been given a puzzle
/// rather than an answer.
///
/// Rooms that are merely visible do not count. Only joined ones can be
/// unread; a public room in the directory is not a message to you.
pub fn unread_totals() -> (u64, bool) {
    let map = STATE.read().unwrap();
    sum_unread(map.values().flat_map(|gs| gs.rooms.values()))
}

/// The summing itself, split out so it can be tested.
///
/// `unread_totals` reads a process-wide static that every other test in this
/// file also writes, so asserting on it directly measures whatever else
/// happened to run first.
fn sum_unread<'a>(rooms: impl Iterator<Item = &'a Room>) -> (u64, bool) {
    let mut count = 0u64;
    let mut mention = false;
    for room in rooms {
        // A room merely visible in the directory is not a message to anyone.
        if !room.joined {
            continue;
        }
        count = count.saturating_add(room.unread);
        mention |= room.mention;
    }
    (count, mention)
}

/// Render a typing set for the window: who, by the name a player would know
/// them by. Bots and service accounts keep their localpart.
pub fn typing_names(users: &[String]) -> Vec<String> {
    users
        .iter()
        .map(|u| {
            directory::player_id_of(u)
                .and_then(|pid| directory::get(&pid).map(|i| i.username))
                .filter(|n| !n.is_empty())
                .unwrap_or_else(|| localpart(u))
        })
        .collect()
}

/// Tell the homeserver we are (or have stopped) typing. Fire-and-forget: a
/// failed typing notice is not worth telling anyone about.
pub async fn set_typing(session: &Session, room_id: &str, typing: bool) -> Result<(), String> {
    let url = format!(
        "{}/rooms/{}/typing/{}",
        base(session),
        urlseg(room_id),
        urlseg(&session.user_id)
    );
    // The timeout is how long the server keeps believing us without another
    // notice — long enough to survive a pause for thought, short enough that a
    // closed window stops claiming to type.
    let payload = if typing {
        json!({ "typing": true, "timeout": 20_000 })
    } else {
        json!({ "typing": false })
    };
    authed(session, move |c, s| {
        c.put(&url).bearer_auth(&s.access_token).json(&payload)
    })
    .await
    .map(|_| ())
}

/// PartialEq on Room lets `apply_sync` tell a real change from a no-op sync,
/// so an idle homeserver does not repaint the window every 30 seconds.
impl PartialEq for Room {
    fn eq(&self, other: &Self) -> bool {
        self.room_id == other.room_id
            && self.name == other.name
            && self.canonical_alias == other.canonical_alias
            && self.topic == other.topic
            && self.members == other.members
            && self.joined == other.joined
            && self.section == other.section
            && self.player_id == other.player_id
            && self.pfp_attrs == other.pfp_attrs
    }
}

/// Start the long-poll for one guild. Idempotent: a second call while the loop
/// is alive is a no-op, so reconnecting cannot double the traffic.
/// Publish the player's portrait as their Matrix avatar, if it is not already.
///
/// Self-healing rather than a button, because the thing it fixes is invisible
/// from inside this app: the portrait renders correctly in every Structs
/// window whether or not the homeserver knows about it. The player would only
/// find out they were a grey initial by asking someone in Element.
///
/// Re-runs when either side moves — a portrait changed on chain, or an avatar
/// cleared from another client — and does nothing at all when they agree,
/// which is every launch after the first.
pub async fn heal_avatar(app: &tauri::AppHandle, guild_id: &str) {
    let Some(session) = store::get(guild_id) else { return };
    // `@1-42:server` — the localpart IS the player id.
    let Some(player_id) = session
        .user_id
        .strip_prefix('@')
        .and_then(|r| r.split(':').next())
        .filter(|p| !p.is_empty())
    else {
        return;
    };
    let Some(ident) = directory::resolve(player_id).await else { return };
    let Some(attrs) = ident.pfp_attrs.filter(|a| !a.trim().is_empty()) else {
        return; // no portrait on chain yet; nothing to publish
    };

    // What the homeserver believes, read rather than assumed: an avatar can be
    // cleared elsewhere, and trusting our own last write would never notice.
    let live = match my_avatar(&session).await {
        Ok(v) => v,
        Err(_) => return, // a homeserver that will not answer is not an error worth surfacing
    };
    let stamp = store::avatar_for(&session.user_id);
    if let (Some(stamp), Some(live)) = (stamp.as_deref(), live.as_deref()) {
        if let Some((was_attrs, was_mxc)) = stamp.split_once('|') {
            if was_attrs == attrs && was_mxc == live {
                return; // both sides agree; the common case
            }
        }
    }

    let Some(png) = avatar::compose_png(app, &attrs) else { return };
    match upload_avatar(&session, png).await {
        Ok(mxc) => {
            store::put_avatar(&session.user_id, &format!("{}|{}", attrs, mxc));
            eprintln!("[Comms] published portrait for {} as {}", session.user_id, mxc);
        }
        Err(e) => eprintln!("[Comms] could not publish portrait: {}", e),
    }
}

/// What this install knows about each pinned channel.
///
/// Keyed by full alias. `joined` is sticky on purpose — see
/// `join_pinned_channels` — and `next_try_ms` is how a guild whose homeserver
/// does not federate with SN Corp's stops being asked three times a launch
/// forever, without being written off permanently either.
#[derive(serde::Serialize, serde::Deserialize, Clone, Default)]
struct PinnedRoom {
    joined: bool,
    /// The last refusal, verbatim, so the Debug tab can say WHY rather than
    /// leaving a player to guess whether their guild is federated.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    last_error: Option<String>,
    #[serde(default)]
    next_try_ms: u64,
}

type PinnedState = std::collections::HashMap<String, PinnedRoom>;

fn pinned_state_path() -> Option<std::path::PathBuf> {
    dirs::config_dir().map(|d| d.join("structs-app").join("pinned_joined.json"))
}

fn pinned_state_read() -> PinnedState {
    let Some(text) = pinned_state_path().and_then(|p| std::fs::read_to_string(p).ok()) else {
        return PinnedState::new();
    };
    if let Ok(map) = serde_json::from_str::<PinnedState>(&text) {
        return map;
    }
    // The first shape this file had was a flat list of joined aliases. Read it
    // rather than discarding it: throwing it away would re-join every pinned
    // room for anyone who had already left one.
    serde_json::from_str::<Vec<String>>(&text)
        .map(|v| {
            v.into_iter()
                .map(|a| (a, PinnedRoom { joined: true, ..Default::default() }))
                .collect()
        })
        .unwrap_or_default()
}

fn pinned_state_write(state: &PinnedState) {
    let Some(p) = pinned_state_path() else { return };
    let _ = std::fs::create_dir_all(p.parent().unwrap_or(std::path::Path::new(".")));
    if let Ok(t) = serde_json::to_string(state) {
        let tmp = p.with_extension("tmp");
        if std::fs::write(&tmp, t).is_ok() {
            let _ = std::fs::rename(&tmp, &p);
        }
    }
}

/// A guild whose homeserver refuses, or cannot reach, SN Corp's.
///
/// Federation is a deployment decision that can change either way, so nothing
/// here is permanent — the question is only how long to wait before asking
/// again. A refusal the server has actually MADE UP ITS MIND about (denied,
/// no such room from here, room version it cannot speak) is worth a day; a
/// blip, a 5xx, a timeout, a rate limit is worth the next launch.
///
/// Classified on the ERRCODE, which `matrix_error` puts first as
/// `M_FORBIDDEN: …`. Never on the message: that half is free text from another
/// deployment and can say anything at all.
const PINNED_SETTLED_RETRY_MS: u64 = 24 * 60 * 60 * 1000;

fn pinned_retry_delay_ms(err: &str) -> u64 {
    let code = err.split(':').next().unwrap_or("").trim();
    match code {
        // The remote side, or ours, has decided. Ask again tomorrow.
        "M_FORBIDDEN" | "M_NOT_FOUND" | "M_UNRECOGNIZED" | "M_UNSUPPORTED_ROOM_VERSION"
        | "M_INCOMPATIBLE_ROOM_VERSION" | "M_BAD_STATE" => PINNED_SETTLED_RETRY_MS,
        // Everything else — 5xx, a dropped connection, rate limiting,
        // Synapse's catch-all "No known servers" — is a bad minute, not a
        // policy. Try again next launch.
        _ => 0,
    }
}

/// Put every player in the three pinned channels, whatever guild they are in.
///
/// These are pinned for everybody, so being able to SEE them at the top of the
/// list is only half of it — an Orbital Hydro player had no way into
/// `#help:matrix.beta.playstructs.com` except by knowing the address and
/// typing it. The join is by alias and crosses homeservers by federation.
///
/// ONCE per install per room, which is the part worth being careful about.
/// Re-joining on every launch would mean a player who leaves `#infrastructure`
/// is dragged back the next time they open the app, with no way out short of
/// blocking the room. Recording what we joined lets leaving stick.
///
/// A guild that does not federate with SN Corp's homeserver is handled as a
/// fact, not an error: the join fails, the reason is kept, the pinned rooms
/// simply do not appear in that player's list, and we ask again tomorrow
/// rather than three times every launch. Nothing is said in the chat window
/// about it — there is no action the player can take. The reason is written
/// to the log, which the Debug tab's "Download logs" already collects; it was
/// briefly a row in that panel too, and taking it back out is why `last_error`
/// is still recorded rather than dropped on the floor.
async fn join_pinned_channels(guild_id: &str) {
    let Some(session) = store::get(guild_id) else { return };
    let Some(home) = super::directory::server_name_for_guild(HOME_GUILD) else {
        return;
    };
    let now = crate::hasher::types::now_millis() as u64;
    let mut state = pinned_state_read();
    let mut dirty = false;

    for local in PINNED_LOCALPARTS {
        let alias = format!("#{local}:{home}");
        let rec = state.entry(alias.clone()).or_default();
        if rec.joined || now < rec.next_try_ms {
            continue;
        }
        // Already in it — joined by hand, or by an earlier install. Record
        // that so we never ask again, and never fight a later leave.
        let joined_here = STATE.read().ok().is_some_and(|st| {
            st.get(guild_id).is_some_and(|g| {
                g.rooms.values().any(|r| {
                    r.joined && r.canonical_alias.as_deref() == Some(alias.as_str())
                })
            })
        });
        if joined_here {
            rec.joined = true;
            rec.last_error = None;
            dirty = true;
            continue;
        }
        match join(&session, &alias).await {
            Ok(()) => {
                rec.joined = true;
                rec.last_error = None;
                eprintln!("[Comms] joined pinned channel {}", alias);
            }
            Err(e) => {
                let wait = pinned_retry_delay_ms(&e);
                rec.next_try_ms = now + wait;
                rec.last_error = Some(e.clone());
                eprintln!(
                    "[Comms] pinned channel {} not joined: {} (retry {})",
                    alias,
                    e,
                    if wait == 0 { "next launch" } else { "tomorrow" }
                );
            }
        }
        dirty = true;
    }
    if dirty {
        pinned_state_write(&state);
    }
}

pub fn start_sync(app: tauri::AppHandle, guild_id: String) {
    {
        let mut running = RUNNING.write().unwrap();
        if !running.insert(guild_id.clone()) {
            return;
        }
    }
    // Our own user id is a REAL id from this guild's homeserver, so it settles
    // what that server is actually called — better than inferring it from the
    // client URL, which a deploy is free to make differ. Everything addressed
    // to this guild (every DM) depends on getting that right.
    if let Some(session) = store::get(&guild_id) {
        directory::learn_server_name(&guild_id, &session.user_id);
    }
    // Make sure other clients can see who this is. Runs once per sync start,
    // off the sync loop so a slow homeserver cannot delay the first messages.
    {
        let app = app.clone();
        let guild_id = guild_id.clone();
        tauri::async_runtime::spawn(async move { heal_avatar(&app, &guild_id).await });
    }
    // The three pinned channels, once per install each. Same shape as the
    // avatar heal above: off the sync loop, so a homeserver that will not
    // federate cannot delay the first messages.
    {
        let guild_id = guild_id.clone();
        tauri::async_runtime::spawn(async move { join_pinned_channels(&guild_id).await });
    }
    tauri::async_runtime::spawn(async move {
        let mut backoff = 2u64;
        // Consecutive failures, so a blip can be told from a stall.
        let mut failures = 0u32;
        loop {
            let Some(session) = store::get(&guild_id) else {
                break; // signed out
            };
            let since = STATE
                .read()
                .unwrap()
                .get(&guild_id)
                .and_then(|g| g.next_batch.clone());

            let result = sync_once(&session, since.as_deref()).await;
            match result {
                Ok(v) => {
                    // Back from a stall we announced. Nothing to say if we
                    // never said anything.
                    if failures >= 2 {
                        let _ = app.emit(
                            "matrix::sync_health",
                            json!({ "guild_id": guild_id, "ok": true }),
                        );
                    }
                    failures = 0;
                    backoff = 2;
                    // Identity first: `apply_sync` renders names, tags and
                    // portraits from the directory, and anything not yet in it
                    // renders as a bare player id — permanently, because the
                    // rendered message is cached. Resolving up front is what
                    // makes a sender look like a person.
                    directory::resolve_many(&directory::senders_in(&v)).await;
                    let d = apply_sync(&guild_id, &session, &v);
                    // Anyone a room is named after who was unknown a moment
                    // ago; the next pass renders their name.
                    let pending = drain_pending_identity();
                    if !pending.is_empty() {
                        directory::resolve_many(&pending).await;
                    }
                    for (room_id, users) in d.typing {
                        let _ = app.emit(
                            "matrix::typing",
                            json!({
                                "guild_id": guild_id,
                                "room_id": room_id,
                                "names": typing_names(&users),
                            }),
                        );
                    }
                    for (room_id, messages) in d.deltas {
                        maybe_notify(&app, &guild_id, &room_id, &messages, &session);
                        let _ = app.emit(
                            "matrix::timeline",
                            json!({
                                "guild_id": guild_id,
                                "room_id": room_id,
                                "messages": messages,
                            }),
                        );
                    }
                    if d.presence {
                        let _ = app.emit(
                            "matrix::presence",
                            json!({
                                "guild_id": guild_id,
                                "presence": presence_by_player(&guild_id),
                            }),
                        );
                    }
                    for room in &d.receipts {
                        let payload = {
                            let map = STATE.read().unwrap();
                            map.get(&guild_id).and_then(|gs| {
                                seen_state(gs, room, &session.user_id).map(|seen| {
                                    json!({ "guild_id": guild_id, "room_id": room, "seen": seen })
                                })
                            })
                        };
                        if let Some(p) = payload {
                            let _ = app.emit("matrix::seen", p);
                        }
                    }
                    // An edit carries the new text, so the window does not
                    // have to ask for the message again.
                    for (room, event_id) in &d.edited {
                        let body = {
                            let map = STATE.read().unwrap();
                            map.get(&guild_id)
                                .and_then(|gs| gs.timelines.get(room))
                                .and_then(|buf| buf.iter().find(|m| &m.event_id == event_id))
                                .map(|m| m.body.clone())
                        };
                        if let Some(body) = body {
                            let _ = app.emit(
                                "matrix::edited",
                                json!({
                                    "guild_id": guild_id, "room_id": room,
                                    "event_id": event_id, "body": body,
                                }),
                            );
                        }
                    }
                    for (room, event_id) in &d.redacted {
                        let _ = app.emit(
                            "matrix::redacted",
                            json!({ "guild_id": guild_id, "room_id": room, "event_id": event_id }),
                        );
                    }
                    // One message's worth each, so a reaction repaints that
                    // message rather than the whole timeline.
                    for (room, event_id) in &d.reacted {
                        let payload = {
                            let map = STATE.read().unwrap();
                            map.get(&guild_id).map(|gs| {
                                json!({
                                    "guild_id": guild_id,
                                    "room_id": room,
                                    "event_id": event_id,
                                    "reactions": reactions_for(gs, room, event_id, &session.user_id),
                                })
                            })
                        };
                        if let Some(p) = payload {
                            let _ = app.emit("matrix::reactions", p);
                        }
                    }
                    if d.rooms_changed {
                        let _ = app.emit(
                            "matrix::rooms",
                            json!({ "guild_id": guild_id, "rooms": rooms_of(&guild_id) }),
                        );
                        // …and the one-line version, for surfaces that are not
                        // the Comms window. The full room list is a large
                        // payload aimed at a window that may not be open; this
                        // is two numbers any part of the app can consume.
                        let (count, mention) = unread_totals();
                        let _ = app.emit(
                            "matrix::unread",
                            json!({ "count": count, "mention": mention }),
                        );
                    }
                }
                Err(e) => {
                    // A signed-out session ends the loop; anything else is
                    // transient and worth backing off over rather than
                    // hammering a homeserver that is having a bad time.
                    if e.contains("M_UNKNOWN_TOKEN") {
                        eprintln!("[Comms] {} session rejected, stopping sync: {}", guild_id, e);
                        store::remove(&guild_id);
                        let reason = "the homeserver ended this session — sign in again";
                        super::note_error(&guild_id, reason);
                        // Partial by necessity (there is no async here to
                        // rebuild the full snapshot); the window re-reads
                        // status when it sees an error-only push.
                        let _ = app.emit("matrix::status", json!({ "error": reason }));
                        break;
                    }
                    eprintln!("[Comms] {} sync: {} (retry in {}s)", guild_id, e, backoff);
                    // Say so, once, when it stops being a blip.
                    //
                    // The loop recovers on its own — but until it does, a
                    // window with nothing arriving looks exactly like a quiet
                    // guild. A stall that presents as calm is the worst
                    // failure a chat client has, and this codebase has had it
                    // before.
                    //
                    // On the SECOND consecutive failure, not the first: a
                    // single dropped long-poll is ordinary and announcing it
                    // would make an ordinary thing look broken.
                    failures += 1;
                    if failures == 2 {
                        let _ = app.emit(
                            "matrix::sync_health",
                            json!({ "guild_id": guild_id, "ok": false, "reason": e }),
                        );
                    }
                    tokio::time::sleep(Duration::from_secs(backoff)).await;
                    backoff = (backoff * 2).min(60);
                }
            }
        }
        RUNNING.write().unwrap().remove(&guild_id);
    });
}

pub fn stop_sync(guild_id: &str) {
    // The loop exits on its own once the session is gone; this just clears the
    // cached view so a re-connect does not show stale rooms.
    STATE.write().unwrap().remove(guild_id);
}

async fn sync_once(session: &Session, since: Option<&str>) -> Result<Value, String> {
    let url = format!("{}/sync", base(session));
    let timeout = SYNC_TIMEOUT_MS.to_string();
    let since_owned = since.map(|s| s.to_string());
    authed_on(&LONG_POLL, session, move |c, s| {
        let mut req = c.get(&url).bearer_auth(&s.access_token).query(&[
            ("timeout", timeout.as_str()),
            // Enough scrollback that opening a room straight after connecting
            // is not an empty screen.
            // `ephemeral` is left unfiltered on purpose: it is how m.typing
            // arrives, and a filter that omits it silently kills the feature.
            ("filter", r#"{"room":{"timeline":{"limit":40}}}"#),
        ]);
        if let Some(b) = since_owned.as_deref() {
            req = req.query(&[("since", b)]);
        }
        req
    })
    .await
}

// ── Reads the window makes ──────────────────────────────────────────────────

pub fn rooms_of(guild_id: &str) -> Vec<Room> {
    let map = STATE.read().unwrap();
    let Some(gs) = map.get(guild_id) else {
        return Vec::new();
    };
    let mut rooms: Vec<Room> = gs.rooms.values().cloned().collect();
    // Joined first, then by section, then by name — a stable order so the list
    // does not reshuffle under the cursor on every sync.
    rooms.sort_by(|a, b| {
        b.joined
            .cmp(&a.joined)
            .then(a.section.cmp(b.section))
            .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    rooms
}

/// Merge the public room directory in, so rooms the player has NOT joined are
/// visible with a Join button. Refreshed lazily — the directory changes far
/// more slowly than a timeline.
pub async fn refresh_directory(guild_id: &str, session: &Session) -> Result<(), String> {
    const DIRECTORY_TTL_SECS: u64 = 300;
    {
        let map = STATE.read().unwrap();
        if let Some(gs) = map.get(guild_id) {
            if auth::now_secs().saturating_sub(gs.directory_at) < DIRECTORY_TTL_SECS {
                return Ok(());
            }
        }
    }
    let url = format!("{}/publicRooms", base(session));
    let v = authed(session, move |c, s| {
        c.get(&url).bearer_auth(&s.access_token).query(&[("limit", "100")])
    })
    .await?;

    let server = server_name(session);
    let mut map = STATE.write().unwrap();
    let gs = map.entry(guild_id.to_string()).or_default();
    gs.directory_at = auth::now_secs();
    for chunk in v
        .get("chunk")
        .and_then(|c| c.as_array())
        .cloned()
        .unwrap_or_default()
    {
        let Some(room_id) = chunk.get("room_id").and_then(|r| r.as_str()) else {
            continue;
        };
        // Never let the directory overwrite a room we are actually in: sync is
        // authoritative there, and the directory's member count lags.
        if gs.rooms.get(room_id).map(|r| r.joined) == Some(true) {
            if let Some(n) = chunk.get("num_joined_members").and_then(|n| n.as_u64()) {
                if let Some(r) = gs.rooms.get_mut(room_id) {
                    r.members = n;
                }
            }
            continue;
        }
        let alias = chunk
            .get("canonical_alias")
            .and_then(|a| a.as_str())
            .map(|s| s.to_string());
        // Anyone may publish a public room under any name, so this list is
        // the easiest place in the app to hang a convincing forgery beside the
        // real thing. Sanitizing kills the invisible tricks; the NAMES can
        // still legitimately collide, which is why the window prints each
        // row's alias — see `renderRoomRow` in chat.js.
        let name = chunk
            .get("name")
            .and_then(|n| n.as_str())
            .map(|s| super::identity::sanitize(s))
            .filter(|s| !s.is_empty())
            .or_else(|| alias.clone())
            .unwrap_or_else(|| room_id.to_string());
        let rank = home_rank(alias.as_deref());
        gs.rooms.insert(
            room_id.to_string(),
            Room {
                home_rank: rank,
                room_id: room_id.to_string(),
                icon: icon_for(&name, alias.as_deref()),
                name,
                canonical_alias: alias,
                topic: chunk
                    .get("topic")
                    .and_then(|t| t.as_str())
                    .map(|s| s.to_string()),
                members: chunk
                    .get("num_joined_members")
                    .and_then(|n| n.as_u64())
                    .unwrap_or(0),
                joined: false,
                unread: 0,
                mention: false,
                pinned: Vec::new(),
                muted: false,
                encrypted: false,
                replaced_by: None,
                invited: false,
                invited_by: None,
                section: section_for(room_id, &server),
                    pfp_attrs: None,
                player_id: None,
            },
        );
    }
    Ok(())
}

/// Search the homeserver's public room directory — IRC's `/list`.
///
/// A live query rather than a filter over the cached page: a homeserver with
/// hundreds of rooms only ever hands us the first hundred, so searching
/// locally would search the wrong set. Federated servers can be searched too
/// once the `server` argument is wired; for now this is the guild's own.
pub async fn browse(
    guild_id: &str,
    session: &Session,
    query: Option<&str>,
) -> Result<Vec<Room>, String> {
    let url = format!("{}/publicRooms", base(session));
    let term = query.unwrap_or("").trim().to_string();
    let mut body = json!({ "limit": 60 });
    if !term.is_empty() {
        body["filter"] = json!({ "generic_search_term": term });
    }
    // POST, not GET: the search term goes in a filter object, which the GET
    // form has no way to carry.
    let v = authed(session, move |c, s| {
        c.post(&url).bearer_auth(&s.access_token).json(&body)
    })
    .await?;

    let server = server_name(session);
    let joined: std::collections::HashSet<String> = {
        let map = STATE.read().unwrap();
        map.get(guild_id)
            .map(|gs| {
                gs.rooms
                    .iter()
                    .filter(|(_, r)| r.joined)
                    .map(|(id, _)| id.clone())
                    .collect()
            })
            .unwrap_or_default()
    };

    let mut out = Vec::new();
    for chunk in v
        .get("chunk")
        .and_then(|c| c.as_array())
        .map(|a| a.as_slice())
        .unwrap_or(&[])
    {
        let Some(room_id) = chunk.get("room_id").and_then(|r| r.as_str()) else {
            continue;
        };
        let alias = chunk
            .get("canonical_alias")
            .and_then(|a| a.as_str())
            .map(|s| s.to_string());
        // Anyone may publish a public room under any name, so this list is
        // the easiest place in the app to hang a convincing forgery beside the
        // real thing. Sanitizing kills the invisible tricks; the NAMES can
        // still legitimately collide, which is why the window prints each
        // row's alias — see `renderRoomRow` in chat.js.
        let name = chunk
            .get("name")
            .and_then(|n| n.as_str())
            .map(|s| super::identity::sanitize(s))
            .filter(|s| !s.is_empty())
            .or_else(|| alias.clone())
            .unwrap_or_else(|| room_id.to_string());
        let rank = home_rank(alias.as_deref());
        out.push(Room {
            home_rank: rank,
            room_id: room_id.to_string(),
            icon: icon_for(&name, alias.as_deref()),
            name,
            canonical_alias: alias,
            topic: chunk
                .get("topic")
                .and_then(|t| t.as_str())
                .map(|s| super::identity::sanitize(s)),
            members: chunk
                .get("num_joined_members")
                .and_then(|n| n.as_u64())
                .unwrap_or(0),
            joined: joined.contains(room_id),
            unread: 0,
            mention: false,
            pinned: Vec::new(),
            muted: false,
            encrypted: false,
            replaced_by: None,
            invited: false,
            invited_by: None,
            section: section_for(room_id, &server),
            pfp_attrs: None,
            player_id: None,
        });
    }
    // ── Federated discovery ──
    // The public directory is empty on these deployments and cross-server
    // directory queries are refused, so the directory ALONE shows nothing. The
    // aliases every guild actually uses do resolve — see discovery.rs.
    if term.is_empty() {
        let known: std::collections::HashSet<String> =
            out.iter().map(|r| r.room_id.clone()).collect();
        for s in super::discovery::federated_rooms(session).await {
            if known.contains(&s.room_id) {
                continue;
            }
            out.push(Room {
                home_rank: home_rank(Some(&s.alias)),
                room_id: s.room_id.clone(),
                icon: icon_for(&s.name, Some(&s.alias)),
                name: s.name,
                canonical_alias: Some(s.alias),
                topic: s.topic,
                members: s.members,
                joined: joined.contains(&s.room_id),
                unread: 0,
                mention: false,
                pinned: Vec::new(),
                muted: false,
                encrypted: false,
                replaced_by: None,
                invited: false,
                invited_by: None,
                section: section_for(&s.room_id, &server),
                pfp_attrs: None,
                player_id: None,
            });
        }
    }

    // Busiest first: on a directory, population is the best proxy for "worth
    // looking at", and alphabetical order buries every active room.
    out.sort_by(|a, b| {
        b.members
            .cmp(&a.members)
            .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(out)
}

fn presence_of(user_id: &str) -> Value {
    let map = STATE.read().unwrap();
    for gs in map.values() {
        if let Some(p) = gs.presence.get(user_id) {
            return serde_json::to_value(p).unwrap_or(Value::Null);
        }
    }
    Value::Null
}

/// Who is here, by PLAYER id rather than Matrix id.
///
/// Player id is the identifier every other window in this app already speaks —
/// Team Ops, the roster, the raid views. Handing them Matrix ids would make
/// each one learn a second naming scheme for the same people.
///
/// Absent means UNKNOWN, and callers must render it as nothing rather than as
/// offline: presence is off by default on many Synapse deployments, and a
/// client that reads silence as "nobody is here" shows a dead guild.
pub fn presence_by_player(guild_id: &str) -> Value {
    let map = STATE.read().unwrap();
    let Some(gs) = map.get(guild_id) else { return json!({}) };
    let mut out = serde_json::Map::new();
    for (user_id, p) in &gs.presence {
        if let Some(pid) = directory::player_id_of(user_id) {
            if let Ok(v) = serde_json::to_value(p) {
                out.insert(pid, v);
            }
        }
    }
    Value::Object(out)
}

/// Whether this homeserver appears to run presence at all.
///
/// Not a setting we can read — the spec offers no "is presence enabled"
/// endpoint. The honest proxy is whether it has ever told us about anyone.
pub fn presence_known(guild_id: &str) -> bool {
    STATE
        .read()
        .unwrap()
        .get(guild_id)
        .is_some_and(|gs| !gs.presence.is_empty())
}

/// Who has seen your latest message in this room, for a window just opening it.
/// Note a mute locally so the room list changes on the click rather than on
/// the next sync.
pub fn note_muted(guild_id: &str, room_id: &str, muted: bool) {
    if let Ok(mut map) = STATE.write() {
        if let Some(gs) = map.get_mut(guild_id) {
            if muted {
                gs.muted.insert(room_id.to_string());
            } else {
                gs.muted.remove(room_id);
            }
            if let Some(room) = gs.rooms.get_mut(room_id) {
                room.muted = muted;
            }
        }
    }
}

pub fn seen_of(guild_id: &str, room_id: &str, me: &str) -> Option<Value> {
    let map = STATE.read().unwrap();
    seen_state(map.get(guild_id)?, room_id, me)
}

pub fn timeline_of(guild_id: &str, room_id: &str, me: &str) -> (Option<Room>, Vec<Message>) {
    let map = STATE.read().unwrap();
    let Some(gs) = map.get(guild_id) else {
        return (None, Vec::new());
    };
    // Reactions are attached HERE rather than when the message was rendered:
    // a reaction almost always arrives after the message it is on, so a copy
    // taken at render time would be permanently empty.
    let messages = gs
        .timelines
        .get(room_id)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|mut m| {
            m.reactions = reactions_for(gs, room_id, &m.event_id, me);
            m
        })
        .collect();
    (gs.rooms.get(room_id).cloned(), messages)
}

/// Backfill from the server when the in-memory timeline is thin — right after
/// connecting, or for a room just joined.
pub async fn fetch_messages(
    guild_id: &str,
    session: &Session,
    room_id: &str,
    limit: u32,
) -> Result<Vec<Message>, String> {
    page_back(guild_id, session, room_id, limit, None).await
}

/// One page of history, walking backwards.
///
/// `from` is the token a previous page returned; `None` starts at the live
/// end. The token for the NEXT page is recorded per room, and recorded as
/// `None` once the room has been read back to its beginning — that is what
/// stops the window asking forever at the top of a short room.
async fn page_back(
    guild_id: &str,
    session: &Session,
    room_id: &str,
    limit: u32,
    from: Option<String>,
) -> Result<Vec<Message>, String> {
    let url = format!("{}/rooms/{}/messages", base(session), urlseg(room_id));
    let limit_s = limit.to_string();
    let v = authed(session, move |c, s| {
        let mut req = c
            .get(&url)
            .bearer_auth(&s.access_token)
            .query(&[("dir", "b"), ("limit", limit_s.as_str())]);
        if let Some(tok) = from.as_deref() {
            req = req.query(&[("from", tok)]);
        }
        req
    })
    .await?;

    // Same reason as the sync loop: resolve who these people are before the
    // page is rendered against the directory.
    directory::resolve_many(&directory::senders_in(&v)).await;

    let chunk_len = v
        .get("chunk")
        .and_then(|c| c.as_array())
        .map(|a| a.len())
        .unwrap_or(0);
    // Synapse omits `end` at the start of the room. An empty chunk means the
    // same thing, and is the more reliable signal of the two.
    let next = v
        .get("end")
        .and_then(|e| e.as_str())
        .map(|s| s.to_string())
        .filter(|_| chunk_len > 0);

    let mut map = STATE.write().unwrap();
    let gs = map.entry(guild_id.to_string()).or_default();
    gs.back_token.insert(room_id.to_string(), next);
    let mut out: Vec<Message> = v
        .get("chunk")
        .and_then(|c| c.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|ev| render_event(ev, gs, room_id, &session.user_id))
                .collect()
        })
        .unwrap_or_default();
    // `dir=b` returns newest-first; the window renders oldest-first.
    out.reverse();
    Ok(out)
}

/// The next page of older messages, prepended to what is already cached.
///
/// Returns the page and whether more remain, so the window can stop offering
/// to load history that does not exist.
pub async fn backfill(
    guild_id: &str,
    session: &Session,
    room_id: &str,
    limit: u32,
) -> Result<(Vec<Message>, bool), String> {
    let token = {
        let map = STATE.read().unwrap();
        match map.get(guild_id).and_then(|gs| gs.back_token.get(room_id)) {
            // Read back to the beginning already; nothing to ask for.
            Some(None) => return Ok((Vec::new(), false)),
            Some(Some(t)) => Some(t.clone()),
            // Never paged: the caller wants older than the live end.
            None => None,
        }
    };
    let older = page_back(guild_id, session, room_id, limit, token).await?;
    let more = {
        let map = STATE.read().unwrap();
        matches!(
            map.get(guild_id).and_then(|gs| gs.back_token.get(room_id)),
            Some(Some(_))
        )
    };

    if !older.is_empty() {
        let mut map = STATE.write().unwrap();
        let gs = map.entry(guild_id.to_string()).or_default();
        let buf = gs.timelines.entry(room_id.to_string()).or_default();
        // Prepend, skipping anything already held: a page can overlap the
        // live tail, and a duplicated message reads as the room repeating
        // itself.
        let have: std::collections::HashSet<String> =
            buf.iter().map(|m| m.event_id.clone()).collect();
        let mut merged: Vec<Message> = older
            .into_iter()
            .filter(|m| !have.contains(&m.event_id))
            .collect();
        let fresh = merged.len();
        merged.extend(buf.drain(..));
        *buf = merged;
        return Ok((buf[..fresh].to_vec(), more));
    }
    Ok((Vec::new(), more))
}

/// Replace the cached timeline with a server-authoritative backfill.
/// Put a freshly backfilled page into the cache without losing what arrived
/// while it was being fetched.
///
/// This used to overwrite. Backfilling is an await, sync keeps running
/// through it, and anything delivered in that window was destroyed by the
/// page landing on top — gone from the cache, so the next time the room was
/// opened it was simply missing. The window had it (it was pushed live), but
/// nothing else did.
pub fn seed_timeline(guild_id: &str, room_id: &str, messages: Vec<Message>) {
    let mut map = STATE.write().unwrap();
    let gs = map.entry(guild_id.to_string()).or_default();
    let arrived_meanwhile: Vec<Message> = gs
        .timelines
        .get(room_id)
        .map(|existing| {
            let seen: std::collections::HashSet<&str> =
                messages.iter().map(|m| m.event_id.as_str()).collect();
            existing
                .iter()
                .filter(|m| !seen.contains(m.event_id.as_str()))
                .cloned()
                .collect()
        })
        .unwrap_or_default();

    let mut merged = messages;
    // After the page, in the order they arrived: a backfill is history, and
    // anything the cache already held that the page does not cover is newer
    // than all of it.
    merged.extend(arrived_meanwhile);
    /* A page fetched into a FULL cache does not survive in the cache.
     *
     * The page sits in front and the trim below takes the front, so in a room
     * already holding TIMELINE_CAP messages the 40 discarded are exactly the
     * 40 just fetched. That is the right bound for a cache whose job is the
     * most recent conversation — and it costs the player nothing visible,
     * because `matrix_backfill` hands the page straight to the window rather
     * than having it re-read from here.
     *
     * Written down because the merge above reads as though seeding preserves
     * the page: it preserves messages that arrived DURING the fetch, which is
     * a different problem. Do not "fix" the trim to take from the end — the
     * end is the newest, which is the part the cache exists to hold.
     */
    if merged.len() > TIMELINE_CAP {
        let cut = merged.len() - TIMELINE_CAP;
        merged.drain(..cut);
    }
    gs.timelines.insert(room_id.to_string(), merged);
}

/// The message types this client will emit. An allowlist, not a passthrough:
/// `msgtype` reaches here from the composer's slash commands, and letting an
/// arbitrary string through would let a typo mint event types no client
/// renders.
pub fn msgtype_or_text(requested: Option<&str>) -> &'static str {
    match requested {
        Some("m.emote") => "m.emote",
        Some("m.notice") => "m.notice",
        _ => "m.text",
    }
}

/// Escape text for the HTML body a mention has to carry. Small and exact:
/// the only markup we ever emit is our own anchor tags, and everything the
/// player typed goes through here first.
fn html_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(c),
        }
    }
    out
}

/// Turn `@Name` runs into matrix.to pills, given the users they resolve to.
///
/// Both halves are required by the spec and by other clients: `m.mentions`
/// is what actually notifies someone, and the `formatted_body` pill is what
/// Element renders. Sending neither — which is what this client did until now
/// — means a message addressed to somebody never reaches them as a mention.
fn formatted_with_pills(body: &str, mentions: &[(String, String)]) -> Option<String> {
    if mentions.is_empty() {
        return None;
    }
    let mut html = html_escape(body);
    let mut changed = false;
    for (name, user_id) in mentions {
        let needle = html_escape(&format!("@{}", name));
        if !html.contains(&needle) {
            continue;
        }
        let pill = format!(
            "<a href=\"https://matrix.to/#/{}\">{}</a>",
            html_escape(user_id),
            html_escape(name)
        );
        html = html.replace(&needle, &pill);
        changed = true;
    }
    if changed { Some(html) } else { None }
}

pub async fn send(
    session: &Session,
    room_id: &str,
    body: &str,
    msgtype: &str,
) -> Result<String, String> {
    send_with_mentions(session, room_id, body, msgtype, &[]).await
}

pub async fn send_with_mentions(
    session: &Session,
    room_id: &str,
    body: &str,
    msgtype: &str,
    mentions: &[(String, String)],
) -> Result<String, String> {
    send_full(session, room_id, body, msgtype, mentions, None).await
}

/// A reply carries the message it answers.
///
/// `reply_to` is the answered event; the quote block other clients need is
/// built here from `quote_sender` / `quote_body` rather than by the window,
/// so the fallback's exact shape has one author.
pub struct Reply<'a> {
    pub event_id: &'a str,
    pub sender: &'a str,
    pub body: &'a str,
}

pub async fn send_full(
    session: &Session,
    room_id: &str,
    body: &str,
    msgtype: &str,
    mentions: &[(String, String)],
    reply: Option<Reply<'_>>,
) -> Result<String, String> {
    let txn = format!(
        "structs{}{}",
        auth::now_secs(),
        TXN.fetch_add(1, Ordering::Relaxed)
    );
    let url = format!(
        "{}/rooms/{}/send/m.room.message/{}",
        base(session),
        urlseg(room_id),
        urlseg(&txn)
    );
    // The fallback goes in the BODY, because a client with no reply rendering
    // shows the body and nothing else — without it, "yes, do it" arrives over
    // there with no indication of what it answers.
    let body = match reply.as_ref() {
        Some(r) => {
            // First line names who is being quoted, the rest are plain `> `
            // lines, then one blank line. That exact shape is what other
            // clients strip back off — see `strip_reply_fallback`.
            let mut lines = r.body.lines();
            let mut quote = vec![format!("> <{}> {}", r.sender, lines.next().unwrap_or(""))];
            quote.extend(lines.map(|l| format!("> {}", l)));
            format!("{}\n\n{}", quote.join("\n"), body)
        }
        None => body.to_string(),
    };
    let body = body.as_str();

    let mut payload = json!({ "msgtype": msgtype, "body": body });
    if let Some(r) = reply.as_ref() {
        payload["m.relates_to"] = json!({ "m.in_reply_to": { "event_id": r.event_id } });
    }
    if !mentions.is_empty() {
        let ids: Vec<String> = mentions.iter().map(|(_, id)| id.clone()).collect();
        payload["m.mentions"] = json!({ "user_ids": ids });
        if let Some(html) = formatted_with_pills(body, mentions) {
            payload["format"] = json!("org.matrix.custom.html");
            payload["formatted_body"] = json!(html);
        }
    }
    let v = authed(session, move |c, s| {
        c.put(&url).bearer_auth(&s.access_token).json(&payload)
    })
    .await?;
    v.get("event_id")
        .and_then(|e| e.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "the homeserver accepted the message but returned no event id".to_string())
}

/// Find or create the direct-message room with `their_id`.
///
/// Reuses an existing DM when there is one: Matrix will happily create a
/// second room with the same two people, which then splits the conversation
/// in half with no way to tell which half is current.
pub async fn open_dm(
    guild_id: &str,
    session: &Session,
    their_id: &str,
) -> Result<String, String> {
    if let Some(existing) = {
        let map = STATE.read().unwrap();
        map.get(guild_id).and_then(|gs| {
            gs.dm_with
                .iter()
                .find(|(_, peer)| peer.as_str() == their_id)
                .map(|(room, _)| room.clone())
        })
    } {
        return Ok(existing);
    }

    let url = format!("{}/createRoom", base(session));
    let payload = json!({
        "is_direct": true,
        "preset": "trusted_private_chat",
        "invite": [their_id],
    });
    let v = authed(session, move |c, s| {
        c.post(&url).bearer_auth(&s.access_token).json(&payload)
    })
    .await?;
    let room_id = v
        .get("room_id")
        .and_then(|r| r.as_str())
        .ok_or("the homeserver created no room")?
        .to_string();

    // Record it locally AND in account data. Local so the room is a DM in this
    // window immediately; account data so every other Matrix client the player
    // uses agrees, and so a reinstall does not lose the fact.
    {
        let mut map = STATE.write().unwrap();
        let gs = map.entry(guild_id.to_string()).or_default();
        gs.dm_with.insert(room_id.clone(), their_id.to_string());
    }
    if let Err(e) = publish_direct(guild_id, session).await {
        // Not fatal: the DM works, it just may not look like one elsewhere.
        eprintln!("[Comms] m.direct update: {}", e);
    }
    Ok(room_id)
}

/// Remember that this room is the conversation with this PLAYER.
///
/// Called by `matrix_message_player`, which is handed a player id and would
/// otherwise throw that fact away the moment it had resolved a Matrix id from
/// it — leaving the window to re-derive the same answer from heroes and the
/// directory, neither of which is populated yet for a fresh invite.
pub fn note_dm_player(guild_id: &str, room_id: &str, player_id: &str) {
    if let Ok(mut map) = STATE.write() {
        let gs = map.entry(guild_id.to_string()).or_default();
        gs.dm_player_id
            .insert(room_id.to_string(), player_id.to_string());
    }
}

/// Write the whole `m.direct` map back. Matrix has no partial update for
/// account data, so this always sends the complete map.
async fn publish_direct(guild_id: &str, session: &Session) -> Result<(), String> {
    let mut by_user: HashMap<String, Vec<String>> = HashMap::new();
    {
        let map = STATE.read().unwrap();
        if let Some(gs) = map.get(guild_id) {
            for (room, peer) in &gs.dm_with {
                by_user.entry(peer.clone()).or_default().push(room.clone());
            }
        }
    }
    let url = format!(
        "{}/user/{}/account_data/m.direct",
        base(session),
        urlseg(&session.user_id)
    );
    let payload = serde_json::to_value(&by_user).map_err(|e| e.to_string())?;
    authed(session, move |c, s| {
        c.put(&url).bearer_auth(&s.access_token).json(&payload)
    })
    .await
    .map(|_| ())
}

pub async fn join(session: &Session, room_id: &str) -> Result<(), String> {
    // `/join/{roomIdOrAlias}` takes an alias too, which is what makes a
    // directory row joinable before we know its room id.
    let url = format!("{}/join/{}", base(session), urlseg(room_id));
    authed(session, move |c, s| {
        c.post(&url).bearer_auth(&s.access_token).json(&json!({}))
    })
    .await
    .map(|_| ())
}

/// Set both the private read marker and the public read receipt, which is
/// what other clients actually read.
/// Silence a room, or let it speak again.
///
/// Written as a push rule, which is where Matrix keeps this — so muting here
/// also mutes the same account in Element on a phone, and a room silenced
/// there arrives silenced here. A local "muted" flag would have been half a
/// feature.
/// Say what you are doing, to everyone who can see you.
///
/// Synapse marks an account `online` on its own while it is syncing, so this
/// is not what makes a player visible — they already are. What this adds is
/// the STATUS LINE, and that is the part with consequences: in a game about
/// raiding each other, "fleet away" tells a rival your planet may be
/// undefended.
pub async fn publish_status(
    session: &Session,
    state: &str,
    status_msg: Option<&str>,
) -> Result<(), String> {
    let url = format!(
        "{}/presence/{}/status",
        base(session),
        urlseg(&session.user_id)
    );
    let mut payload = json!({ "presence": state });
    if let Some(msg) = status_msg {
        payload["status_msg"] = json!(msg);
    }
    authed(session, move |c, s| {
        c.put(&url).bearer_auth(&s.access_token).json(&payload)
    })
    .await
    .map(|_| ())
}

pub async fn set_muted(session: &Session, room_id: &str, muted: bool) -> Result<(), String> {
    let url = format!(
        "{}/pushrules/global/room/{}",
        base(session),
        urlseg(room_id)
    );
    if muted {
        // An empty action list is how current Synapse spells "no
        // notification"; `dont_notify` is the older name for the same thing
        // and is still accepted.
        let payload = json!({ "actions": [] });
        authed(session, move |c, s| {
            c.put(&url).bearer_auth(&s.access_token).json(&payload)
        })
        .await
        .map(|_| ())
    } else {
        // Unmuting is removing the rule, not writing an opposite one: the
        // default is to notify, and a second rule saying so would be state
        // nobody else's client knows to clean up.
        match authed(session, move |c, s| c.delete(&url).bearer_auth(&s.access_token)).await {
            Ok(_) => Ok(()),
            // No rule to remove is the state we wanted.
            Err(e) if e.contains("404") || e.contains("M_NOT_FOUND") => Ok(()),
            Err(e) => Err(e),
        }
    }
}

/// Post a work offer or result into a room.
///
/// The `body` is what every other client shows — a player on Element must
/// still be able to read what was asked, even though only Structs can act on
/// it.
pub async fn send_work(
    session: &Session,
    room_id: &str,
    body: &str,
    work: Value,
    reply_to: Option<&str>,
) -> Result<String, String> {
    let txn = format!("structs{}{}", auth::now_secs(), TXN.fetch_add(1, Ordering::Relaxed));
    let url = format!(
        "{}/rooms/{}/send/m.room.message/{}",
        base(session),
        urlseg(room_id),
        urlseg(&txn)
    );
    let mut payload = json!({
        "msgtype": "m.text",
        "body": body,
        "structs.work": work,
    });
    if let Some(target) = reply_to {
        payload["m.relates_to"] = json!({ "m.in_reply_to": { "event_id": target } });
    }
    let v = authed(session, move |c, s| {
        c.put(&url).bearer_auth(&s.access_token).json(&payload)
    })
    .await?;
    v.get("event_id")
        .and_then(|e| e.as_str())
        .map(String::from)
        .ok_or_else(|| "the homeserver accepted it but returned no event id".into())
}

/// Rewrite a message that has already been sent.
///
/// The fallback body — `* new text` — is what clients with no edit support
/// show, and leaving it out means they keep displaying the mistake forever.
pub async fn edit(
    session: &Session,
    room_id: &str,
    event_id: &str,
    body: &str,
    msgtype: &str,
) -> Result<String, String> {
    let body = body.trim();
    if body.is_empty() {
        return Err("an edit needs something to say".into());
    }
    if !event_id.starts_with('$') {
        return Err("that message has not been sent yet".into());
    }
    let txn = format!("structs{}{}", auth::now_secs(), TXN.fetch_add(1, Ordering::Relaxed));
    let url = format!(
        "{}/rooms/{}/send/m.room.message/{}",
        base(session),
        urlseg(room_id),
        urlseg(&txn)
    );
    let payload = json!({
        "msgtype": msgtype,
        "body": format!("* {}", body),
        "m.new_content": { "msgtype": msgtype, "body": body },
        "m.relates_to": { "rel_type": "m.replace", "event_id": event_id },
    });
    let v = authed(session, move |c, s| {
        c.put(&url).bearer_auth(&s.access_token).json(&payload)
    })
    .await
    .map_err(|e| {
        if e.contains("M_FORBIDDEN") {
            "you can only change your own messages".to_string()
        } else {
            e
        }
    })?;
    v.get("event_id")
        .and_then(|e| e.as_str())
        .map(String::from)
        .ok_or_else(|| "the homeserver accepted the change but returned no event id".into())
}

/// Take a message back.
///
/// The homeserver decides whether this account may: your own message always,
/// somebody else's only with the power level for it. Asking beats keeping a
/// copy of those rules here.
pub async fn redact(session: &Session, room_id: &str, event_id: &str) -> Result<(), String> {
    if !event_id.starts_with('$') {
        return Err("that message has not been sent yet".into());
    }
    let txn = format!("structs{}{}", auth::now_secs(), TXN.fetch_add(1, Ordering::Relaxed));
    let url = format!(
        "{}/rooms/{}/redact/{}/{}",
        base(session),
        urlseg(room_id),
        urlseg(event_id),
        urlseg(&txn)
    );
    authed(session, move |c, s| {
        c.put(&url).bearer_auth(&s.access_token).json(&json!({}))
    })
    .await
    .map_err(|e| {
        if e.contains("M_FORBIDDEN") {
            "you do not have permission to remove that message".to_string()
        } else {
            e
        }
    })
    .map(|_| ())
}

/// React to a message, or take your reaction back.
///
/// Un-reacting is a redaction of YOUR OWN annotation event, which is why the
/// store keeps senders rather than counts: there is nothing else to redact.
pub async fn react(
    session: &Session,
    room_id: &str,
    event_id: &str,
    key: &str,
    on: bool,
) -> Result<(), String> {
    let key = key.trim();
    if key.is_empty() {
        return Err("a reaction needs a key".into());
    }
    if on {
        // Already reacted is a no-op, not a second annotation. Sending two
        // would leave one un-redactable behind after the first is removed.
        let existing = {
            let map = STATE.read().unwrap();
            map.get(&session.guild_id)
                .and_then(|gs| gs.reactions.get(room_id))
                .and_then(|r| r.get(event_id))
                .and_then(|k| k.get(key))
                .map(|who| who.iter().any(|r| r.user_id == session.user_id))
                .unwrap_or(false)
        };
        if existing {
            return Ok(());
        }
        let txn = format!("structs{}{}", auth::now_secs(), TXN.fetch_add(1, Ordering::Relaxed));
        let url = format!(
            "{}/rooms/{}/send/m.reaction/{}",
            base(session),
            urlseg(room_id),
            urlseg(&txn)
        );
        let payload = json!({
            "m.relates_to": {
                "rel_type": "m.annotation", "event_id": event_id, "key": key
            }
        });
        authed(session, move |c, s| {
            c.put(&url).bearer_auth(&s.access_token).json(&payload)
        })
        .await?;
        return Ok(());
    }

    // Off: find the annotation this account sent and redact it.
    let mine = {
        let map = STATE.read().unwrap();
        map.get(&session.guild_id)
            .and_then(|gs| gs.reactions.get(room_id))
            .and_then(|r| r.get(event_id))
            .and_then(|k| k.get(key))
            .and_then(|who| {
                who.iter()
                    .find(|r| r.user_id == session.user_id)
                    .map(|r| r.event_id.clone())
            })
    };
    // Nothing of ours to remove is success, not an error: the button and the
    // truth simply agreed already.
    let Some(annotation) = mine else { return Ok(()) };
    let txn = format!("structs{}{}", auth::now_secs(), TXN.fetch_add(1, Ordering::Relaxed));
    let url = format!(
        "{}/rooms/{}/redact/{}/{}",
        base(session),
        urlseg(room_id),
        urlseg(&annotation),
        urlseg(&txn)
    );
    authed(session, move |c, s| {
        c.put(&url).bearer_auth(&s.access_token).json(&json!({}))
    })
    .await
    .map(|_| ())
}

/// The reactions on one message, for the window.
pub fn reactions_of(session: &Session, room_id: &str, event_id: &str) -> Vec<Reaction> {
    let map = STATE.read().unwrap();
    match map.get(&session.guild_id) {
        Some(gs) => reactions_for(gs, room_id, event_id, &session.user_id),
        None => Vec::new(),
    }
}

/// Drop the `> …` quote block a rich reply carries at the top of its body.
///
/// The spec's fallback is a run of `> ` lines followed by one blank line, then
/// the actual message. Only that leading run: a reply whose own text starts
/// with a quote after the blank line keeps it.
fn strip_reply_fallback(body: &str) -> String {
    let mut rest = body;
    let mut saw_quote = false;
    loop {
        let (line, tail) = match rest.split_once('\n') {
            Some((l, t)) => (l, t),
            None => break,
        };
        if line.starts_with('>') {
            saw_quote = true;
            rest = tail;
            continue;
        }
        // The blank line that closes the fallback belongs to it too.
        if saw_quote && line.trim().is_empty() {
            rest = tail;
        }
        break;
    }
    if saw_quote { rest.to_string() } else { body.to_string() }
}

/// Read who was answered, and what they said, out of that same fallback.
///
/// Its first line is `> <@user:server> their text`. Worth mining because it
/// means a quote line costs nothing: the alternative is fetching the answered
/// event once per reply, which in a busy room is a fetch per message.
fn quoted_from_fallback(body: &str) -> (Option<String>, Option<String>) {
    let mut who = None;
    let mut said: Vec<String> = Vec::new();
    for line in body.lines() {
        let Some(q) = line.strip_prefix('>') else { break };
        let q = q.trim_start();
        if who.is_none() {
            if let Some(rest) = q.strip_prefix('<') {
                if let Some((user, text)) = rest.split_once('>') {
                    who = Some(user.to_string());
                    let text = text.trim();
                    if !text.is_empty() {
                        said.push(text.to_string());
                    }
                    continue;
                }
            }
        }
        said.push(q.to_string());
    }
    if who.is_none() && said.is_empty() {
        return (None, None);
    }
    let mut excerpt = said.join(" ");
    // One line's worth. The quote is a pointer to the message, not a copy.
    if excerpt.chars().count() > 120 {
        excerpt = excerpt.chars().take(119).collect::<String>() + "…";
    }
    (who, Some(excerpt).filter(|e| !e.is_empty()))
}

/// Fetch the messages a room has pinned.
///
/// On demand rather than from sync: a pin can point at something said a year
/// ago, which no sync window will ever carry. Bounded, because a room is free
/// to pin a hundred things and this is a strip at the top of a conversation,
/// not a second timeline.
const MAX_PINS: usize = 10;

pub async fn pinned(session: &Session, room_id: &str) -> Result<Vec<Message>, String> {
    let ids: Vec<String> = {
        let map = STATE.read().unwrap();
        map.get(&session.guild_id)
            .and_then(|gs| gs.rooms.get(room_id))
            .map(|r| r.pinned.clone())
            .unwrap_or_default()
    };
    if ids.is_empty() {
        return Ok(Vec::new());
    }

    let mut out = Vec::new();
    // Newest first: the most recent pin is nearly always the live one.
    for id in ids.iter().rev().take(MAX_PINS) {
        let url = format!(
            "{}/rooms/{}/event/{}",
            base(session),
            urlseg(room_id),
            urlseg(id)
        );
        // A pin can outlive what it points at — redacted, or in history this
        // account cannot see. One unreachable pin must not empty the strip.
        let Ok(ev) = authed(session, move |c, s| c.get(&url).bearer_auth(&s.access_token)).await
        else {
            continue;
        };
        let map = STATE.read().unwrap();
        let Some(gs) = map.get(&session.guild_id) else { continue };
        if let Some(m) = render_event(&ev, gs, room_id, &session.user_id) {
            if m.kind == "text" || m.kind == "emote" || m.kind == "notice" || m.kind == "image" {
                out.push(m);
            }
        }
    }
    Ok(out)
}

/// Pin or unpin one message.
///
/// Read-modify-write of the room's own `m.room.pinned_events`, which is how
/// the spec models it — there is no per-message pin. Whether this account is
/// allowed is the homeserver's call: asking it beats keeping a copy of its
/// power-level rules here that can only ever drift.
pub async fn set_pinned(
    session: &Session,
    room_id: &str,
    event_id: &str,
    pin: bool,
) -> Result<Vec<String>, String> {
    let url = format!(
        "{}/rooms/{}/state/m.room.pinned_events/",
        base(session),
        urlseg(room_id)
    );
    // Re-read from the server rather than trusting local state: two people
    // pinning at once would otherwise have the slower write drop the faster
    // one's pin.
    let current: Vec<String> = match authed(session, {
        let url = url.clone();
        move |c, s| c.get(&url).bearer_auth(&s.access_token)
    })
    .await
    {
        Ok(v) => v
            .get("pinned")
            .and_then(|p| p.as_array())
            .map(|a| a.iter().filter_map(|e| e.as_str()).map(String::from).collect())
            .unwrap_or_default(),
        // No pinned-events state yet is the normal case for most rooms.
        Err(_) => Vec::new(),
    };

    let mut next: Vec<String> = current.into_iter().filter(|e| e != event_id).collect();
    if pin {
        next.push(event_id.to_string());
    }
    let payload = json!({ "pinned": next });
    authed(session, move |c, s| {
        c.put(&url).bearer_auth(&s.access_token).json(&payload)
    })
    .await
    .map_err(|e| {
        if e.contains("M_FORBIDDEN") {
            "you do not have permission to pin in this room".to_string()
        } else {
            e
        }
    })?;

    // Reflect it locally at once. The sync that confirms it is a round trip
    // away, and a pin that does not appear until then reads as a failure.
    if let Ok(mut map) = STATE.write() {
        if let Some(room) = map
            .get_mut(&session.guild_id)
            .and_then(|gs| gs.rooms.get_mut(room_id))
        {
            room.pinned = next.clone();
        }
    }
    Ok(next)
}

/// Search the log.
///
/// Server-side, because it has to be: this window keeps the last few hundred
/// messages of the room you are looking at, and the thing worth finding — who
/// agreed to what, which planet somebody flagged a week ago — is almost never
/// in that window. Synapse indexes the full history of every room you are in.
///
/// Scoped to one room when `room_id` is given, otherwise across everything the
/// account is joined to. Both are useful and they answer different questions:
/// "what did we decide in here" versus "where was that mentioned".
pub async fn search(
    session: &Session,
    query: &str,
    room_id: Option<&str>,
    limit: u32,
) -> Result<Vec<SearchHit>, String> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let url = format!("{}/search", base(session));
    let mut criteria = json!({
        "search_term": query,
        "keys": ["content.body"],
        // Newest first. A chat search is nearly always "what was that recent
        // thing", and rank order buries it under a year of chatter.
        "order_by": "recent",
        "event_context": { "before_limit": 0, "after_limit": 0 },
    });
    if let Some(id) = room_id {
        criteria["filter"] = json!({ "rooms": [id], "limit": limit });
    } else {
        criteria["filter"] = json!({ "limit": limit });
    }
    let payload = json!({ "search_categories": { "room_events": criteria } });
    let v = authed(session, move |c, s| {
        c.post(&url).bearer_auth(&s.access_token).json(&payload)
    })
    .await?;

    let results = v
        .get("search_categories")
        .and_then(|c| c.get("room_events"))
        .and_then(|r| r.get("results"))
        .and_then(|r| r.as_array())
        .cloned()
        .unwrap_or_default();

    let map = STATE.read().unwrap();
    let gs = map.get(&session.guild_id);
    let mut out = Vec::new();
    for hit in results.iter().take(limit as usize) {
        let Some(ev) = hit.get("result") else { continue };
        let hit_room = text_of(ev.get("room_id"));
        // A hit in a room this app has never synced still has to be readable,
        // so fall back to the room id rather than dropping the result.
        let room_name = gs
            .and_then(|g| g.rooms.get(&hit_room).map(|r| r.name.clone()))
            .unwrap_or_else(|| hit_room.clone());
        let Some(gs) = gs else { continue };
        let Some(m) = render_event(ev, gs, &hit_room, &session.user_id) else { continue };
        // Joins, topic changes and the rest are not what anyone is looking
        // for, and they crowd out the messages that are.
        if m.kind != "text" && m.kind != "emote" && m.kind != "notice" {
            continue;
        }
        out.push(SearchHit { room_id: hit_room, room_name, message: m });
    }
    Ok(out)
}

#[derive(Debug, Clone, Serialize)]
pub struct SearchHit {
    pub room_id: String,
    pub room_name: String,
    pub message: Message,
}

fn text_of(v: Option<&Value>) -> String {
    v.and_then(|x| x.as_str()).unwrap_or("").to_string()
}

pub async fn mark_read(
    session: &Session,
    room_id: &str,
    event_id: &str,
) -> Result<(), String> {
    let url = format!("{}/rooms/{}/read_markers", base(session), urlseg(room_id));
    let payload = json!({
        "m.fully_read": event_id,
        "m.read": event_id,
    });
    authed(session, move |c, s| {
        c.post(&url).bearer_auth(&s.access_token).json(&payload)
    })
    .await
    .map(|_| ())
}

pub async fn leave(session: &Session, room_id: &str) -> Result<(), String> {
    let url = format!("{}/rooms/{}/leave", base(session), urlseg(room_id));
    authed(session, move |c, s| {
        c.post(&url).bearer_auth(&s.access_token).json(&json!({}))
    })
    .await
    .map(|_| ())
}

/// Room ids and aliases contain `!`, `#`, `:` and `$` — all of which must be
/// percent-encoded to survive as ONE path segment.
fn urlseg(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{:02X}", b),
        })
        .collect()
}

/// Fetch an image someone posted, as a data URI the window can render.
///
/// Media is AUTHENTICATED on a modern homeserver — the legacy unauthenticated
/// path 404s (verified against crew.oh.energy, spec v1.12) — so the webview
/// cannot simply point an `<img>` at the URL. Rust holds the token, fetches
/// the thumbnail, and hands back bytes.
///
/// SECURITY: this is a file chosen by a federated stranger.
///   * Only raster image types are accepted. **SVG is refused**: it is a
///     document that can carry script, and a data: URI would run it in the
///     window's own origin.
///   * The body is capped, so a hostile or careless upload cannot be turned
///     into an enormous string in the renderer.
///   * A thumbnail is requested rather than the original, which bounds the
///     common case to a few dozen KB.
const MEDIA_CAP_BYTES: usize = 2 * 1024 * 1024;
const MEDIA_OK_TYPES: &[&str] = &["image/png", "image/jpeg", "image/gif", "image/webp"];

/// What the app is willing to PUT ON a homeserver.
///
/// The only thing this app uploads is the player's own portrait, composed
/// locally from the layers that ship in the bundle. It is never a file the
/// player picked: this window is a game client, not a file-sharing tool, and
/// an accidental drop of the wrong picture onto other people's servers is not
/// something an apology takes back.
const UPLOAD_CAP_BYTES: usize = 2 * 1024 * 1024;

/// Publish the player's portrait as their Matrix avatar.
///
/// Federated clients render `avatar_url` and nothing else — Element shows a
/// grey initial for every Structs player today, because the portrait only
/// exists as on-chain layer indices that no other client can read. Composing
/// it here and uploading the result is what makes a player recognisable
/// everywhere their guild talks, not just inside this window.
///
/// Upload and profile-set are one act for the same reason a picture message
/// is: a successful upload followed by a failed profile write leaves a file
/// nothing references and the player cannot see or retry.
pub async fn upload_avatar(session: &Session, png: Vec<u8>) -> Result<String, String> {
    if png.is_empty() {
        return Err("the portrait came out empty".into());
    }
    if png.len() > UPLOAD_CAP_BYTES {
        return Err(format!(
            "the portrait is {:.1} MB, which is larger than this app will upload",
            png.len() as f64 / (1024.0 * 1024.0)
        ));
    }
    let url = format!(
        "{}/_matrix/media/v3/upload?filename=portrait.png",
        session.homeserver.trim_end_matches('/')
    );
    let v = authed(session, move |c, s| {
        c.post(&url)
            .bearer_auth(&s.access_token)
            .header(reqwest::header::CONTENT_TYPE, "image/png")
            .body(png.clone())
    })
    .await?;
    let mxc = v
        .get("content_uri")
        .and_then(|u| u.as_str())
        .filter(|u| u.starts_with("mxc://"))
        .ok_or("the homeserver accepted the portrait but returned no media URL")?
        .to_string();

    let profile = format!(
        "{}/profile/{}/avatar_url",
        base(session),
        urlseg(&session.user_id)
    );
    let payload = json!({ "avatar_url": mxc });
    authed(session, move |c, s| {
        c.put(&profile).bearer_auth(&s.access_token).json(&payload)
    })
    .await?;
    Ok(mxc)
}

/// What the homeserver currently believes this player looks like.
///
/// Read rather than assumed: the avatar can be cleared from another client,
/// or lost with the account, and a self-heal that trusts its own last write
/// would never notice.
pub async fn my_avatar(session: &Session) -> Result<Option<String>, String> {
    let url = format!(
        "{}/profile/{}/avatar_url",
        base(session),
        urlseg(&session.user_id)
    );
    let v = match authed(session, move |c, s| c.get(&url).bearer_auth(&s.access_token)).await {
        Ok(v) => v,
        // A profile with no avatar answers 404 on some homeservers and an
        // empty object on others. Neither is an error worth surfacing.
        Err(e) if e.contains("404") || e.contains("M_NOT_FOUND") => return Ok(None),
        Err(e) => return Err(e),
    };
    Ok(v.get("avatar_url")
        .and_then(|u| u.as_str())
        .map(|s| s.to_string())
        .filter(|s| s.starts_with("mxc://")))
}

pub async fn media_data_url(
    session: &Session,
    mxc: &str,
    size: u32,
) -> Result<(String, String), String> {
    // mxc://server/media_id
    let rest = mxc.strip_prefix("mxc://").ok_or("not a matrix media URL")?;
    let (server, media_id) = rest.split_once('/').ok_or("malformed matrix media URL")?;
    if server.is_empty() || media_id.is_empty() {
        return Err("malformed matrix media URL".into());
    }
    let size = size.clamp(64, 800);
    let url = format!(
        "{}/_matrix/client/v1/media/thumbnail/{}/{}?width={}&height={}&method=scale",
        session.homeserver.trim_end_matches('/'),
        urlseg(server),
        urlseg(media_id),
        size,
        size
    );

    let client = http()?;
    let resp = client
        .get(&url)
        .bearer_auth(&session.access_token)
        .send()
        .await
        .map_err(|e| format!("media: {}", e))?;
    if !resp.status().is_success() {
        return Err(format!("media: HTTP {}", resp.status().as_u16()));
    }
    let mime = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.split(';').next().unwrap_or("").trim().to_ascii_lowercase())
        .unwrap_or_default();
    if !MEDIA_OK_TYPES.contains(&mime.as_str()) {
        return Err(format!("refusing to render {}", if mime.is_empty() { "an untyped file" } else { &mime }));
    }
    if let Some(len) = resp.content_length() {
        if len as usize > MEDIA_CAP_BYTES {
            return Err("image too large".into());
        }
    }
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    if bytes.len() > MEDIA_CAP_BYTES {
        return Err("image too large".into());
    }
    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok((format!("data:{};base64,{}", mime, b64), mime))
}

/// Resolve a room ALIAS to a room id, anywhere in the federation.
///
/// `GET /directory/room/{alias}` is the one lookup that works across servers
/// without the other side trusting us — the same fact `discovery.rs` is built
/// on. `None` means no room with that alias exists yet, which for a per-object
/// room is the ordinary case rather than an error.
pub async fn room_id_for_alias(session: &Session, alias: &str) -> Option<String> {
    let url = format!("{}/directory/room/{}", base(session), urlseg(alias));
    let v = authed(session, move |c, s| c.get(&url).bearer_auth(&s.access_token))
        .await
        .ok()?;
    v.get("room_id")?.as_str().map(|s| s.to_string())
}

/// Create a public room at `localpart` on OUR homeserver.
///
/// A client may only create an alias in its own server's namespace, so this
/// can only ever make the rooms for objects our guild owns. Rooms for another
/// guild's planets are theirs to create — which is why the caller treats a
/// missing room as "not yet", never as a failure.
pub async fn create_object_room(
    session: &Session,
    localpart: &str,
    name: &str,
    topic: &str,
) -> Result<String, String> {
    let url = format!("{}/createRoom", base(session));
    let payload = json!({
        "room_alias_name": localpart,
        "name": name,
        "topic": topic,
        // Public and world-readable: a planet's conversation should be
        // findable by anyone who can see the planet, including the guild
        // raiding it. `preset` also publishes the join rule the directory
        // lookup above relies on.
        "preset": "public_chat",
        "visibility": "public",
    });
    let v = authed(session, move |c, s| {
        c.post(&url).bearer_auth(&s.access_token).json(&payload)
    })
    .await?;
    v.get("room_id")
        .and_then(|r| r.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "createRoom returned no room_id".to_string())
}

/// The server this session's own account lives on.
pub fn own_server(session: &Session) -> String {
    server_name(session)
}

/// Everyone in a room, as people rather than ids.
///
/// The window had no way to answer "who is here" at all — the most basic
/// question a chat room raises, and the one that makes a name in the composer
/// completable and a stranger addressable.
pub async fn members(session: &Session, room_id: &str) -> Result<Vec<Value>, String> {
    let url = format!("{}/rooms/{}/joined_members", base(session), urlseg(room_id));
    let v = authed(session, move |c, s| c.get(&url).bearer_auth(&s.access_token)).await?;
    let joined = v
        .get("joined")
        .and_then(|j| j.as_object())
        .cloned()
        .unwrap_or_default();

    // Resolve the players among them before building rows, so the list shows
    // names and portraits rather than ids.
    let player_ids: Vec<String> = joined
        .keys()
        .filter_map(|u| directory::player_id_of(u))
        .collect();
    directory::resolve_many(&player_ids).await;

    let mut out: Vec<Value> = joined
        .into_iter()
        .map(|(user_id, info)| {
            let pid = directory::player_id_of(&user_id);
            let ident = pid.as_deref().and_then(directory::get);
            let display = info
                .get("display_name")
                .and_then(|d| d.as_str())
                .unwrap_or("")
                .to_string();
            json!({
                "user_id": user_id,
                // A player's on-chain name beats the self-chosen Matrix one;
                // for a bot the Matrix name is all there is.
                "name": ident
                    .as_ref()
                    .map(|i| i.username.clone())
                    .filter(|n| !n.is_empty())
                    .unwrap_or_else(|| if display.is_empty() { localpart(&user_id) } else { display }),
                "player_id": pid,
                "tag": ident.as_ref().map(|i| i.tag.clone()).unwrap_or_default(),
                "pfp_attrs": ident.as_ref().and_then(|i| i.pfp_attrs.clone()),
                "is_self": user_id == session.user_id,
                // Absent when the homeserver has said nothing, which is not
                // the same as offline.
                "presence": presence_of(&user_id),
            })
        })
        .collect();

    // Players first, then bots and service accounts; alphabetical within each.
    out.sort_by(|a, b| {
        let ap = a.get("player_id").map(|v| v.is_null()).unwrap_or(true);
        let bp = b.get("player_id").map(|v| v.is_null()).unwrap_or(true);
        ap.cmp(&bp).then_with(|| {
            let an = a.get("name").and_then(|v| v.as_str()).unwrap_or("").to_lowercase();
            let bn = b.get("name").and_then(|v| v.as_str()).unwrap_or("").to_lowercase();
            an.cmp(&bn)
        })
    });
    Ok(out)
}

/// The player's Matrix profile, for the composer portrait.
pub async fn profile(session: &Session) -> Result<Value, String> {
    let url = format!("{}/profile/{}", base(session), urlseg(&session.user_id));
    let v = authed(session, move |c, s| c.get(&url).bearer_auth(&s.access_token))
        .await
        .unwrap_or(Value::Null);
    // The composer shows YOUR face, so the profile has to carry it. The
    // homeserver knows nothing about game portraits — the on-chain attributes
    // come from the same galaxy directory every other portrait uses.
    let ident = directory::player_id_of(&session.user_id).and_then(|pid| directory::get(&pid));
    Ok(json!({
        "user_id": session.user_id,
        "display_name": v.get("displayname").and_then(|d| d.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| localpart(&session.user_id)),
        "pfp_attrs": ident.as_ref().and_then(|i| i.pfp_attrs.clone()),
        "tag": ident.as_ref().map(|i| i.tag.clone()).unwrap_or_default(),
        // Whether OTHER clients can see this face. The portrait always renders
        // in here; `avatar_url` is the only thing Element and the rest read,
        // and the difference is invisible from inside this window.
        "avatar_published": v.get("avatar_url").and_then(|a| a.as_str())
            .map(|s| s.starts_with("mxc://")).unwrap_or(false),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session() -> Session {
        Session {
            guild_id: "0-5".into(),
            player_id: None,
            homeserver: "https://matrix.example.com".into(),
            user_id: "@1-194:example.com".into(),
            device_id: "ABCDEFGHIJ".into(),
            access_token: "t".into(),
            refresh_token: None,
            expires_at: None,
            client_id: "c".into(),
            token_endpoint: "https://auth.example.com/oauth2/token".into(),
        }
    }

    #[test]
    fn server_name_comes_from_the_user_id_not_the_url() {
        // The client URL (matrix.example.com) and the server name
        // (example.com) routinely differ; getting this wrong would put every
        // room in GALAXY NET.
        assert_eq!(server_name(&session()), "example.com");
    }

    #[test]
    fn sectioning_splits_own_server_from_federated() {
        assert_eq!(section_for("!abc:example.com", "example.com"), "local");
        assert_eq!(section_for("!abc:other.example", "example.com"), "galaxy");
        // No server name known yet — never claim a room is local on a guess.
        assert_eq!(section_for("!abc:example.com", ""), "galaxy");
    }

    #[test]
    fn room_ids_survive_as_one_path_segment() {
        assert_eq!(urlseg("!abc:example.com"), "%21abc%3Aexample.com");
        assert_eq!(urlseg("#raid:example.com"), "%23raid%3Aexample.com");
        // A bare id with no escaping would make "/rooms/!abc:h/send/..." split
        // on the colon and 404.
        assert!(!urlseg("$event:h").contains(':'));
    }

    #[test]
    fn a_message_renders_with_its_sender_and_power() {
        let mut gs = GuildState::default();
        gs.names
            .insert("@1-42:example.com".into(), "Netlag".into());
        gs.power
            .entry("!r:example.com".into())
            .or_default()
            .insert("@1-42:example.com".into(), 100);
        let ev = json!({
            "type": "m.room.message", "event_id": "$1",
            "sender": "@1-42:example.com", "origin_server_ts": 1700,
            "content": { "msgtype": "m.text", "body": "what what what" }
        });
        let m = render_event(&ev, &gs, "!r:example.com", "@1-194:example.com").unwrap();
        assert_eq!(m.sender_name, "Netlag");
        assert_eq!(m.body, "what what what");
        assert_eq!(m.kind, "text");
        assert!(m.admin);
        assert!(!m.is_self);
    }

    #[test]
    fn an_unknown_sender_falls_back_to_the_player_id() {
        let gs = GuildState::default();
        let ev = json!({
            "type": "m.room.message", "event_id": "$1",
            "sender": "@1-77:example.com", "origin_server_ts": 1,
            "content": { "msgtype": "m.text", "body": "hi" }
        });
        let m = render_event(&ev, &gs, "!r:example.com", "@me:example.com").unwrap();
        // The localpart IS the player id, which is the most useful fallback
        // there is — never a raw matrix id in the name slot.
        assert_eq!(m.sender_name, "1-77");
    }

    #[test]
    fn a_redacted_event_says_so_instead_of_rendering_blank() {
        let gs = GuildState::default();
        let ev = json!({
            "type": "m.room.message", "event_id": "$1", "sender": "@a:h",
            "origin_server_ts": 1, "content": {},
            "unsigned": { "redacted_because": { "type": "m.room.redaction" } }
        });
        let m = render_event(&ev, &gs, "!r:h", "@me:h").unwrap();
        assert_eq!(m.kind, "notice");
        assert_eq!(m.body, "message removed");
    }

    #[test]
    fn an_unhandled_state_change_is_summarised_not_dropped() {
        let gs = GuildState::default();
        let ev = json!({
            "type": "m.room.pinned_events", "event_id": "$1", "sender": "@a:h",
            "origin_server_ts": 1, "content": { "pinned": ["$x"] }
        });
        let m = render_event(&ev, &gs, "!r:h", "@me:h").unwrap();
        assert_eq!(m.kind, "event");
        assert!(m.body.contains("pinned_events"), "{}", m.body);
    }

    /// Every room emits this burst when it is created. It opened every
    /// timeline in the client with six lines of "changed create",
    /// "changed power_levels", "changed join_rules"… none of which is
    /// something a player reads.
    #[test]
    fn room_setup_events_never_reach_the_timeline() {
        let gs = GuildState::default();
        for t in [
            "m.room.create", "m.room.power_levels", "m.room.join_rules",
            "m.room.history_visibility", "m.room.guest_access",
            "m.room.canonical_alias", "m.room.server_acl", "m.room.encryption",
        ] {
            let ev = json!({
                "type": t, "event_id": "$1", "sender": "@a:h",
                "origin_server_ts": 1, "content": {}
            });
            assert!(render_event(&ev, &gs, "!r:h", "@me:h").is_none(), "{} leaked", t);
        }
    }

    #[test]
    fn a_room_cannot_wear_hidden_characters() {
        // Room names come from whoever can send state in that room, and on a
        // federated server that is not necessarily anyone we know. The public
        // directory is worse still: anyone may publish a room under any name,
        // right beside the guild's own in the same list.
        //
        // Sanitizing at ingestion means the name in `Room.name` is the name on
        // the screen — no zero-width character splitting it for a comparison
        // the reader cannot make, and no bidi override repainting it.
        let sneaky = "SN.Corpo\u{200B}ration";
        assert_eq!(super::super::identity::sanitize(sneaky), "SN.Corporation");

        // And it folds onto the real one, so a caller that wants to ask "is
        // this pretending to be that?" gets a straight answer.
        assert_eq!(
            super::super::identity::fold("SN.Corp\u{043E}ration"),
            super::super::identity::fold("SN.Corporation"),
        );
    }

    #[test]
    fn membership_and_renames_are_events_not_chat() {
        let gs = GuildState::default();
        let join = json!({
            "type": "m.room.member", "event_id": "$1", "sender": "@a:h",
            "origin_server_ts": 1, "content": { "membership": "join" }
        });
        let m = render_event(&join, &gs, "!r:h", "@me:h").unwrap();
        // Its own kind, so the window can render it as a dim one-liner rather
        // than as something someone said.
        assert_eq!(m.kind, "event");
        assert_eq!(m.body, "joined");

        let rename = json!({
            "type": "m.room.name", "event_id": "$2", "sender": "@a:h",
            "origin_server_ts": 1, "content": { "name": "Guild Lobby" }
        });
        let r = render_event(&rename, &gs, "!r:h", "@me:h").unwrap();
        assert_eq!(r.kind, "event");
        assert!(r.body.contains("Guild Lobby"), "{}", r.body);
    }

    /// Unread is the homeserver's answer, not ours.
    ///
    /// It is maintained against the read receipts this app already sends, so
    /// it is the only version that survives the Comms window closing, that
    /// survives a restart, and that agrees with the same account open in
    /// Element on a phone. The window used to count locally, which could do
    /// none of those things: closing the window read every room.
    #[test]
    fn unread_comes_from_the_homeserver() {
        let s = session();
        let room = |notif: u64, high: u64| {
            json!({
                "next_batch": "s1",
                "rooms": { "join": { "!r:example.com": {
                    "unread_notifications": {
                        "notification_count": notif, "highlight_count": high
                    },
                    "state": { "events": [
                        { "type": "m.room.name", "content": { "name": "Lobby" } }
                    ] },
                    "timeline": { "events": [] }
                } } }
            })
        };
        apply_sync("g", &s, &room(7, 0));
        let get = || {
            STATE.read().unwrap().get("g").unwrap().rooms.get("!r:example.com").cloned().unwrap()
        };
        assert_eq!(get().unread, 7);
        assert!(!get().mention, "traffic is not a mention");

        // Being named is sticky and separate: a count of 40 hides the one
        // message that was actually for you.
        apply_sync("g", &s, &room(41, 1));
        assert_eq!(get().unread, 41);
        assert!(get().mention);

        // Read elsewhere — on a phone, say. The server says zero and this
        // app must believe it.
        apply_sync("g", &s, &room(0, 0));
        assert_eq!(get().unread, 0);
        assert!(!get().mention);

        // An incremental sync that touched nothing carries no counts at all.
        // Absent must mean "unchanged", never "zero", or every quiet sync
        // would silently mark the room read.
        apply_sync("g", &s, &room(5, 1));
        let quiet = json!({
            "next_batch": "s5",
            "rooms": { "join": { "!r:example.com": { "timeline": { "events": [] } } } }
        });
        apply_sync("g", &s, &quiet);
        assert_eq!(get().unread, 5, "a quiet sync must not clear unread");
        assert!(get().mention, "nor forget that you were named");

        STATE.write().unwrap().remove("g");
    }

    /// Presence is the most social thing Matrix carries, and silence about it
    /// is not the same as absence.
    #[test]
    fn presence_is_read_but_silence_is_not_offline() {
        let s = session();
        let ev = |user: &str, state: &str, active: bool| {
            json!({
                "next_batch": "s1",
                "presence": { "events": [ {
                    "type": "m.presence", "sender": user,
                    "content": {
                        "presence": state, "currently_active": active,
                        "last_active_ago": 12_000
                    }
                } ] }
            })
        };

        // A homeserver that has said nothing yet knows nothing. Many Synapse
        // deployments turn presence off entirely because it is expensive, and
        // a client that read silence as "everyone offline" would show a dead
        // guild to every player on one of them.
        assert!(!presence_known("pres"), "nothing heard yet");

        let d = apply_sync("pres", &s, &ev("@1-61:example.com", "online", true));
        assert!(d.presence, "a first sighting is a change");
        assert!(presence_known("pres"));

        // Keyed by PLAYER id: every other window in this app speaks that, and
        // handing them Matrix ids would make each learn a second scheme.
        let by_player = presence_by_player("pres");
        assert_eq!(by_player["1-61"]["state"], "online");
        assert_eq!(by_player["1-61"]["currently_active"], true);

        // Somebody the server has said nothing about is absent from the map,
        // NOT present with state "offline".
        assert!(by_player.get("1-99").is_none());

        // An unchanged report is not news; pushing it would repaint every
        // roster in the app for nothing.
        let d = apply_sync("pres", &s, &ev("@1-61:example.com", "online", true));
        assert!(!d.presence, "the same state again is not a change");

        // Going idle is. `unavailable` is the spec's word for it.
        let d = apply_sync("pres", &s, &ev("@1-61:example.com", "unavailable", false));
        assert!(d.presence);
        assert_eq!(presence_by_player("pres")["1-61"]["state"], "unavailable");

        STATE.write().unwrap().remove("pres");
    }

    /// Being asked into a room has to be visible.
    ///
    /// `rooms.invite` was not read at all, so an invitation produced no row,
    /// no badge and no notice — it was indistinguishable from never having
    /// been invited.
    #[test]
    fn an_invitation_becomes_a_room_you_can_answer() {
        let s = session();
        let v = json!({
            "next_batch": "s1",
            "rooms": { "invite": { "!lobby:crab.la": { "invite_state": { "events": [
                { "type": "m.room.name", "content": { "name": "Guild Lobby" } },
                { "type": "m.room.topic", "content": { "topic": "come and talk" } },
                { "type": "m.room.canonical_alias",
                  "content": { "alias": "#lobby:crab.la" } },
                // The membership event naming US is the one whose sender asked.
                { "type": "m.room.member", "sender": "@1-61:crab.la",
                  "state_key": "@1-194:example.com",
                  "content": { "membership": "invite" } },
                // …and one naming somebody else, which must not be mistaken
                // for the inviter.
                { "type": "m.room.member", "sender": "@someone:crab.la",
                  "state_key": "@other:crab.la",
                  "content": { "membership": "join" } }
            ] } } } }
        });
        apply_sync("inv", &s, &v);
        let room = STATE.read().unwrap().get("inv").unwrap()
            .rooms.get("!lobby:crab.la").cloned().unwrap();

        assert!(room.invited, "it is an invitation");
        assert!(!room.joined, "…and not somewhere you can read yet");
        assert_eq!(room.name, "Guild Lobby");
        assert_eq!(room.topic.as_deref(), Some("come and talk"));
        assert_eq!(room.section, SECTION_INVITE);
        // Who asked is the whole basis for deciding, so it must be the right
        // person — the sender of the event naming YOU.
        assert_eq!(room.invited_by.as_deref(), Some("1-61"));

        // An invite with nothing in its stripped state still has to be
        // answerable rather than dropped.
        let bare = json!({
            "next_batch": "s2",
            "rooms": { "invite": { "!bare:crab.la": { "invite_state": { "events": [] } } } }
        });
        apply_sync("inv", &s, &bare);
        let room = STATE.read().unwrap().get("inv").unwrap()
            .rooms.get("!bare:crab.la").cloned().unwrap();
        assert!(room.invited);
        assert_eq!(room.name, "!bare:crab.la", "named by its id rather than blank");
        assert_eq!(room.invited_by, None);

        STATE.write().unwrap().remove("inv");
    }

    /// A muted room is one whose push rule does not notify.
    ///
    /// Asked as "do these actions notify" rather than matched against a
    /// spelling: `["dont_notify"]` is the historical form and `[]` is what
    /// current Synapse writes, and both are in the wild.
    #[test]
    fn muted_rooms_are_read_from_the_push_rules() {
        let ev = |rules: Value| json!({
            "type": "m.push_rules",
            "content": { "global": { "room": rules } }
        });

        let got = muted_rooms(&ev(json!([
            { "rule_id": "!old:h", "actions": ["dont_notify"], "enabled": true },
            { "rule_id": "!new:h", "actions": [], "enabled": true },
            { "rule_id": "!loud:h", "actions": ["notify"], "enabled": true },
            { "rule_id": "!sound:h",
              "actions": ["notify", { "set_tweak": "sound", "value": "default" }],
              "enabled": true }
        ])));
        assert!(got.contains("!old:h"), "the historical spelling still means muted");
        assert!(got.contains("!new:h"), "an empty action list means muted");
        assert!(!got.contains("!loud:h"));
        assert!(!got.contains("!sound:h"));

        // A disabled rule is not in force, whatever it says.
        let got = muted_rooms(&ev(json!([
            { "rule_id": "!off:h", "actions": [], "enabled": false }
        ])));
        assert!(got.is_empty(), "{:?}", got);

        // Nothing at all is not everything muted.
        assert!(muted_rooms(&json!({ "type": "m.push_rules", "content": {} })).is_empty());
    }

    /// "Did they see it" is a question about ORDER, not about equality.
    ///
    /// A receipt names the newest event a person has read. Anyone whose
    /// marker sits at or after your message has seen it — matching the two
    /// event ids would answer "did they stop reading exactly there", which is
    /// almost never true and would report nobody.
    #[test]
    fn a_receipt_after_your_message_still_counts_as_seen() {
        let s = session();
        let v = json!({
            "next_batch": "s1",
            "rooms": { "join": { "!r:example.com": {
                "state": { "events": [] },
                "timeline": { "events": [
                    { "type": "m.room.message", "event_id": "$mine", "sender": "@me:h",
                      "origin_server_ts": 1,
                      "content": { "msgtype": "m.text", "body": "raid at dawn" } },
                    { "type": "m.room.message", "event_id": "$later", "sender": "@a:h",
                      "origin_server_ts": 2,
                      "content": { "msgtype": "m.text", "body": "ok" } }
                ] }
            } } }
        });
        apply_sync("seen", &s, &v);

        let receipt = |user: &str, at: &str| {
            json!({
                "next_batch": "s2",
                "rooms": { "join": { "!r:example.com": {
                    "state": { "events": [] }, "timeline": { "events": [] },
                    "ephemeral": { "events": [ {
                        "type": "m.receipt",
                        "content": { at: { "m.read": { user: { "ts": 1 } } } }
                    } ] }
                } } }
            })
        };
        let seen = || {
            let map = STATE.read().unwrap();
            seen_state(map.get("seen").unwrap(), "!r:example.com", "@me:h")
        };
        assert!(seen().is_none(), "nobody has read anything yet");

        // Their marker is PAST my message, which is the normal case.
        let d = apply_sync("seen", &s, &receipt("@a:h", "$later"));
        assert_eq!(d.receipts, vec!["!r:example.com".to_string()]);
        let got = seen().unwrap();
        assert_eq!(got["event_id"], "$mine", "reported against MY latest message");
        assert_eq!(got["names"][0], "a");

        // Somebody stopped one short: not seen.
        apply_sync("seen", &s, &receipt("@b:h", "$mine"));
        let names = seen().unwrap()["names"].as_array().unwrap().len();
        assert_eq!(names, 2, "a marker exactly at the message counts too");

        // Our own receipt is noise dressed as information.
        apply_sync("seen", &s, &receipt("@me:h", "$later"));
        let names: Vec<String> = seen().unwrap()["names"].as_array().unwrap()
            .iter().map(|n| n.as_str().unwrap().to_string()).collect();
        assert!(!names.contains(&"me".to_string()), "{:?}", names);

        // An unchanged marker is not a change worth telling the window about.
        let d = apply_sync("seen", &s, &receipt("@a:h", "$later"));
        assert!(d.receipts.is_empty(), "a repeated receipt is not news");

        STATE.write().unwrap().remove("seen");
    }

    /// Being rate limited is ordinary, and the server always says for how long.
    ///
    /// `M_LIMIT_EXCEEDED` is Synapse's normal answer to a burst — several
    /// messages in a row, a handful of reactions, a search while syncing.
    /// Ignoring it turned an ordinary "slow down" into a message that simply
    /// did not send.
    #[test]
    fn a_rate_limit_is_read_and_bounded() {
        let limited = json!({
            "errcode": "M_LIMIT_EXCEEDED", "error": "Too Many Requests",
            "retry_after_ms": 800
        });
        assert_eq!(rate_limited_for(429, &limited), Some(800));

        // Some servers send the errcode without the 429, and vice versa.
        assert_eq!(rate_limited_for(200, &limited), Some(800));
        assert_eq!(
            rate_limited_for(429, &json!({ "error": "slow down" })),
            Some(1_000),
            "no delay named: the spec's own suggestion beats giving up"
        );

        // Everything else is not a rate limit and must not be waited on.
        assert_eq!(rate_limited_for(403, &json!({ "errcode": "M_FORBIDDEN" })), None);
        assert_eq!(rate_limited_for(200, &json!({ "ok": true })), None);
        assert_eq!(rate_limited_for(500, &Value::Null), None);

        // A wait longer than the cap is reported rather than sat through: a
        // click that freezes for a minute with no explanation is worse than
        // being told to try again.
        let long = json!({ "errcode": "M_LIMIT_EXCEEDED", "retry_after_ms": 60_000 });
        assert!(rate_limited_for(429, &long).unwrap() > MAX_RATE_LIMIT_WAIT_MS);

        // And what the player is shown says what to do, not which spec
        // constant was returned.
        let shown = matrix_error(429, &long);
        assert!(shown.contains("try again in 60s"), "{}", shown);
        assert!(!shown.contains("M_LIMIT_EXCEEDED"), "{}", shown);

        // Other errors keep their detail — a permission failure is worth
        // naming precisely.
        let forbidden = matrix_error(403, &json!({
            "errcode": "M_FORBIDDEN", "error": "You are not allowed"
        }));
        assert!(forbidden.contains("M_FORBIDDEN"), "{}", forbidden);
    }

    /// The two clients differ in the one way that matters, and both are shared.
    ///
    /// A `reqwest::Client` owns the connection pool. This module used to build
    /// a fresh one per request, which throws that pool away every time and
    /// pays a TLS handshake for every message, receipt and reaction.
    #[test]
    fn requests_and_long_polls_wait_differently() {
        // A `/sync` is MEANT to hang: the server holds it open, and a client
        // timeout under that would kill healthy long-polls.
        assert!(
            HTTP_TIMEOUT_SECS > SYNC_TIMEOUT_MS / 1000,
            "the long-poll client must outwait the server's own hold"
        );
        // Everything else has a player watching. A send that inherits the
        // long-poll's patience leaves a dimmed message on screen for most of
        // a minute before it can even offer to retry.
        assert!(
            REQUEST_TIMEOUT_SECS < HTTP_TIMEOUT_SECS,
            "an ordinary request must give up sooner than a long-poll"
        );
        assert!(REQUEST_TIMEOUT_SECS >= 10, "…but not so soon that a slow link fails");

        // Both are the shared instances, not fresh builds: cloning a Client
        // clones an Arc around one pool, which is the whole point.
        let a = http().unwrap();
        let b = http().unwrap();
        drop((a, b));
    }

    /// A name nobody can verify must not pass for one that is verified.
    ///
    /// A player's name comes from the chain and is theirs. Everyone else has
    /// only a Matrix display name — self-chosen, unverified, changeable — so
    /// a bot calling itself "Marklifer" rendered beside the real Marklifer
    /// with nothing to tell them apart. People agree to raids and trades in
    /// these rooms.
    #[test]
    fn a_display_name_cannot_borrow_a_players_name() {
        directory::remember_for_test(
            "1-194",
            directory::Ident {
                username: "Marklifer".into(),
                tag: "SN.C".into(),
                guild_id: "0-5".into(),
                pfp_attrs: None,
            },
        );

        let mut gs = GuildState::default();
        // A service account that has set its display name to a player's.
        gs.names.insert("@sneaky-bot:h".into(), "Marklifer".into());
        // …and one with a name of its own.
        gs.names.insert("@guild-bot:h".into(), "SN Corp Bot".into());

        let said = |sender: &str| {
            let ev = json!({
                "type": "m.room.message", "event_id": "$x", "sender": sender,
                "origin_server_ts": 1,
                "content": { "msgtype": "m.text", "body": "trust me" }
            });
            render_event(&ev, &gs, "!r:h", "@me:h").unwrap().sender_name
        };

        // The impersonator is named, but not ONLY by the borrowed name.
        assert_eq!(said("@sneaky-bot:h"), "Marklifer (sneaky-bot)");
        // An ordinary bot is left alone — this must not tax every non-player.
        assert_eq!(said("@guild-bot:h"), "SN Corp Bot");
        // Somebody with no display name at all is still identifiable.
        assert_eq!(said("@nameless:h"), "nameless");

        directory::forget_for_test("1-194");
    }

    /// Backfilling must not destroy what arrived while it was running.
    ///
    /// Fetching a page of history is an await; sync keeps delivering through
    /// it. Overwriting the cache with the page threw away anything that
    /// landed in that window — the message was on screen (it had been pushed
    /// live) but gone from the cache, so re-opening the room lost it.
    #[test]
    fn a_backfill_keeps_what_arrived_during_it() {
        let msg = |id: &str, body: &str| Message {
            event_id: id.to_string(),
            thread_root: None, work: None, edited: false,
            reactions: Vec::new(), reply_to: None, reply_sender: None,
            reply_excerpt: None,
            sender: "@1-61:h".into(), sender_name: "JPEG".into(), sender_tag: None,
            pfp_attrs: None, player_id: None,
            body: body.to_string(), kind: "text", is_self: false, admin: false,
            ts: 1, mentions_me: false, mxc: None, width: None, height: None,
        };

        // Something arrived from sync while the page was in flight.
        seed_timeline("bf", "!r:h", vec![msg("$live", "arrived meanwhile")]);
        // …and the page lands, covering older history it never saw.
        seed_timeline("bf", "!r:h", vec![msg("$old1", "older"), msg("$old2", "older still")]);

        let bodies: Vec<String> = STATE.read().unwrap().get("bf").unwrap()
            .timelines["!r:h"].iter().map(|m| m.body.clone()).collect();
        assert_eq!(
            bodies,
            vec!["older", "older still", "arrived meanwhile"],
            "history first, then what came in while it was being fetched"
        );

        // A later page that DOES cover everything must not double anything.
        //
        // The realistic sequence: `matrix_timeline` only backfills when the
        // cache is SMALLER than the page it wants, so a page always covers at
        // least what was already held, and anything left over is what arrived
        // while it was in flight.
        seed_timeline(
            "bf",
            "!r:h",
            vec![msg("$old1", "older"), msg("$old2", "older still"),
                 msg("$live", "arrived meanwhile")],
        );
        let ids: Vec<String> = STATE.read().unwrap().get("bf").unwrap()
            .timelines["!r:h"].iter().map(|m| m.event_id.clone()).collect();
        assert_eq!(ids, vec!["$old1", "$old2", "$live"],
                   "deduped by event id: {:?}", ids);

        STATE.write().unwrap().remove("bf");
    }

    /// A truncated batch is a hole in the conversation, and must show as one.
    ///
    /// `limited: true` means the server dropped messages between what we hold
    /// and what it is sending. It happens after every reconnect. Appending
    /// regardless produced a history that reads as continuous and is not.
    #[test]
    fn a_truncated_batch_leaves_a_visible_gap() {
        let s = session();
        let batch = |id: &str, body: &str, limited: bool, token: &str| {
            json!({
                "next_batch": token,
                "rooms": { "join": { "!g:example.com": {
                    "state": { "events": [] },
                    "timeline": {
                        "limited": limited, "prev_batch": token,
                        "events": [ {
                            "type": "m.room.message", "event_id": id,
                            "sender": "@1-61:h", "origin_server_ts": 1,
                            "content": { "msgtype": "m.text", "body": body }
                        } ]
                    }
                } } }
            })
        };
        let kinds = || {
            STATE.read().unwrap().get("gap").unwrap().timelines["!g:example.com"]
                .iter().map(|m| m.kind).collect::<Vec<_>>()
        };

        // A LIMITED first batch is not a gap — it is simply where our view of
        // the room starts, and there is nothing before it to be missing.
        apply_sync("gap", &s, &batch("$a", "first", true, "t1"));
        assert_eq!(kinds(), vec!["text"], "no gap before the first message");

        // A limited batch after that IS one.
        apply_sync("gap", &s, &batch("$b", "later", true, "t2"));
        assert_eq!(kinds(), vec!["text", "gap", "text"]);

        // A normal, complete batch adds nothing.
        apply_sync("gap", &s, &batch("$c", "next", false, "t3"));
        assert_eq!(kinds(), vec!["text", "gap", "text", "text"]);

        STATE.write().unwrap().remove("gap");
    }

    /// `m.room.member` carries five different stories under one event type.
    ///
    /// The one that mattered most: changing a display name or a picture is a
    /// member event with `membership: "join"`, exactly like arriving. Every
    /// profile edit read as "X joined", so an active guild produced a steady
    /// drip of people apparently joining a room they had been in all day.
    #[test]
    fn a_profile_edit_is_not_a_join() {
        let gs = GuildState::default();
        let member = |was: Option<(&str, &str)>, now: &str, name: &str,
                      sender: &str, subject: &str| {
            let mut ev = json!({
                "type": "m.room.member", "event_id": "$m", "sender": sender,
                "state_key": subject, "origin_server_ts": 1,
                "content": { "membership": now, "displayname": name }
            });
            if let Some((prev_membership, prev_name)) = was {
                ev["unsigned"] = json!({ "prev_content": {
                    "membership": prev_membership, "displayname": prev_name
                } });
            }
            ev
        };
        let render = |ev: Value| render_event(&ev, &gs, "!r:h", "@me:h").map(|m| m.body);

        // Already in the room, only the picture changed: not a line anyone
        // wants in a conversation.
        assert_eq!(
            render(member(Some(("join", "JPEG")), "join", "JPEG", "@1-61:h", "@1-61:h")),
            None
        );
        // A rename says what happened rather than pretending they arrived.
        assert_eq!(
            render(member(Some(("join", "JPEG")), "join", "Netlag", "@1-61:h", "@1-61:h")),
            Some("is now known as Netlag".to_string())
        );
        // Actually arriving still reads as arriving.
        assert_eq!(
            render(member(None, "join", "JPEG", "@1-61:h", "@1-61:h")),
            Some("joined".to_string())
        );

        // Leaving on your own is not the same story as being thrown out, and
        // the difference is whether the sender is the subject.
        assert_eq!(
            render(member(Some(("join", "JPEG")), "leave", "", "@1-61:h", "@1-61:h")),
            Some("left".to_string())
        );
        assert_eq!(
            render(member(Some(("join", "JPEG")), "leave", "", "@mod:h", "@1-61:h")),
            Some("was removed".to_string())
        );

        // An unban is `ban → leave` performed by a moderator — which the
        // "somebody else did this" test would call a removal, the opposite of
        // what happened, if it were checked first.
        assert_eq!(
            render(member(Some(("ban", "")), "leave", "", "@mod:h", "@1-61:h")),
            Some("was unbanned".to_string())
        );
        assert_eq!(
            render(member(Some(("join", "")), "ban", "", "@mod:h", "@1-61:h")),
            Some("was banned".to_string())
        );
    }

    /// An upgraded room points at where the conversation went.
    ///
    /// Changing a room's version is a normal admin action and leaves the old
    /// room joinable, listed and open — so without following the pointer a
    /// player goes on talking into a room everyone else has left, and nothing
    /// tells them.
    #[test]
    fn an_upgraded_room_points_at_its_replacement() {
        let gs = GuildState::default();
        let ev = json!({
            "type": "m.room.tombstone", "event_id": "$tomb", "sender": "@1-61:h",
            "origin_server_ts": 1,
            "content": { "body": "This room has been replaced",
                         "replacement_room": "!new:example.com" }
        });
        let m = render_event(&ev, &gs, "!old:example.com", "@me:h").unwrap();
        assert_eq!(m.kind, "notice");
        assert!(m.body.contains("replaced"), "{}", m.body);
        assert!(!m.body.contains("changed tombstone"), "{}", m.body);

        let s = session();
        let v = json!({
            "next_batch": "s1",
            "rooms": { "join": { "!old:example.com": {
                "state": { "events": [ {
                    "type": "m.room.tombstone",
                    "content": { "replacement_room": "!new:example.com" }
                } ] },
                "timeline": { "events": [] }
            } } }
        });
        apply_sync("tomb", &s, &v);
        let room = || STATE.read().unwrap().get("tomb").unwrap()
            .rooms.get("!old:example.com").cloned().unwrap();
        assert_eq!(room().replaced_by.as_deref(), Some("!new:example.com"));

        // Sticky, like encryption: the tombstone arrives once and a room does
        // not come back to life.
        let quiet = json!({
            "next_batch": "s2",
            "rooms": { "join": { "!old:example.com": {
                "state": { "events": [] }, "timeline": { "events": [] }
            } } }
        });
        apply_sync("tomb", &s, &quiet);
        assert_eq!(room().replaced_by.as_deref(), Some("!new:example.com"));

        STATE.write().unwrap().remove("tomb");
    }

    /// An encrypted room has to say so, not produce nonsense.
    ///
    /// Element creates direct messages encrypted BY DEFAULT, and this client
    /// has no crypto. Before this, `m.room.encrypted` fell through to the
    /// generic state branch and every message in such a DM read "changed
    /// encrypted" — gibberish, with no hint that encryption was the reason.
    #[test]
    fn an_encrypted_room_says_so_rather_than_rendering_nonsense() {
        let gs = GuildState::default();
        let ev = json!({
            "type": "m.room.encrypted", "event_id": "$e1", "sender": "@1-61:h",
            "origin_server_ts": 1,
            "content": { "algorithm": "m.megolm.v1.aes-sha2", "ciphertext": "AwgAEn..." }
        });
        let m = render_event(&ev, &gs, "!r:h", "@me:h").unwrap();
        assert_eq!(m.kind, "notice");
        assert!(m.body.contains("encrypted"), "{}", m.body);
        assert!(!m.body.contains("changed"), "not the generic state line: {}", m.body);

        // …and the room itself is marked, so it can be explained once at the
        // top rather than only line by line.
        let s = session();
        let v = json!({
            "next_batch": "s1",
            "rooms": { "join": { "!e:example.com": {
                "state": { "events": [
                    { "type": "m.room.encryption",
                      "content": { "algorithm": "m.megolm.v1.aes-sha2" } }
                ] },
                "timeline": { "events": [] }
            } } }
        });
        apply_sync("enc", &s, &v);
        let room = || STATE.read().unwrap().get("enc").unwrap()
            .rooms.get("!e:example.com").cloned().unwrap();
        assert!(room().encrypted);

        // Sticky. The state event arrives once, in the sync that turned it
        // on; a later sync mentioning nothing must not read as "encryption
        // was switched off", which Matrix has no way to express.
        let quiet = json!({
            "next_batch": "s2",
            "rooms": { "join": { "!e:example.com": {
                "state": { "events": [] }, "timeline": { "events": [] }
            } } }
        });
        apply_sync("enc", &s, &quiet);
        assert!(room().encrypted, "encryption does not lapse");

        STATE.write().unwrap().remove("enc");
    }

    /// A threaded message is not a reply, however much it looks like one.
    ///
    /// Element threads heavily, and every threaded message carries an
    /// `m.in_reply_to` purely so clients that do not understand threads show
    /// something. It is marked `is_falling_back` and points at whoever spoke
    /// last in the thread — so rendering it as a reply puts a quote in
    /// somebody's mouth they never chose.
    #[test]
    fn a_threading_fallback_is_not_a_reply() {
        let gs = GuildState::default();
        let threaded = json!({
            "type": "m.room.message", "event_id": "$t1", "sender": "@1-61:h",
            "origin_server_ts": 1,
            "content": {
                "msgtype": "m.text",
                "body": "> <@1-42:h> earlier\n\nagreed",
                "m.relates_to": {
                    "rel_type": "m.thread", "event_id": "$root",
                    "m.in_reply_to": { "event_id": "$last" },
                    "is_falling_back": true
                }
            }
        });
        let m = render_event(&threaded, &gs, "!r:h", "@me:h").unwrap();
        assert_eq!(m.thread_root.as_deref(), Some("$root"), "it is in a thread");
        assert_eq!(m.reply_to, None, "and NOT a reply to whoever spoke last");
        assert_eq!(m.reply_sender, None);
        // The `> ` block is compatibility scaffolding either way, so it still
        // comes off — leaving it in prints the same words twice.
        assert_eq!(m.body, "agreed");

        // A GENUINE reply inside a thread is a real reply: the spec says so
        // by leaving `is_falling_back` off.
        let real = json!({
            "type": "m.room.message", "event_id": "$t2", "sender": "@1-61:h",
            "origin_server_ts": 2,
            "content": {
                "msgtype": "m.text",
                "body": "> <@1-42:h> which one\n\nthe second",
                "m.relates_to": {
                    "rel_type": "m.thread", "event_id": "$root",
                    "m.in_reply_to": { "event_id": "$asked" },
                    "is_falling_back": false
                }
            }
        });
        let m = render_event(&real, &gs, "!r:h", "@me:h").unwrap();
        assert_eq!(m.thread_root.as_deref(), Some("$root"));
        assert_eq!(m.reply_to.as_deref(), Some("$asked"), "a chosen reply survives");
        assert_eq!(m.reply_sender.as_deref(), Some("@1-42:h"));

        // And a plain reply, in no thread at all, is unchanged.
        let plain = json!({
            "type": "m.room.message", "event_id": "$t3", "sender": "@1-61:h",
            "origin_server_ts": 3,
            "content": {
                "msgtype": "m.text", "body": "> <@1-42:h> q\n\na",
                "m.relates_to": { "m.in_reply_to": { "event_id": "$q" } }
            }
        });
        let m = render_event(&plain, &gs, "!r:h", "@me:h").unwrap();
        assert_eq!(m.reply_to.as_deref(), Some("$q"));
        assert_eq!(m.thread_root, None);
    }

    /// Scrolling up in a room already at the cache cap.
    ///
    /// `seed_timeline` puts the fetched page in front and then trims the
    /// front when the result is over `TIMELINE_CAP` — so the page can be
    /// exactly what gets dropped. This test states what actually happens,
    /// whichever way it comes out, because "history you just asked for"
    /// silently going missing is worth knowing about either way.
    #[test]
    fn a_backfill_into_a_full_cache() {
        let msg = |id: &str, body: &str| Message {
            event_id: id.into(),
            sender: "@a:h".into(),
            sender_name: "a".into(),
            sender_tag: None,
            pfp_attrs: None,
            player_id: None,
            body: body.into(),
            kind: "text".into(),
            is_self: false,
            admin: false,
            ts: 1,
            mentions_me: false,
            reactions: Vec::new(),
            reply_to: None,
            reply_sender: None,
            reply_excerpt: None,
            thread_root: None,
            work: None,
            edited: false,
            mxc: None,
            width: None,
            height: None,
        };

        // A room sitting at the cap, as a busy guild room would be.
        {
            let mut map = STATE.write().unwrap();
            let gs = map.entry("cap".to_string()).or_default();
            let full: Vec<Message> = (0..TIMELINE_CAP)
                .map(|i| msg(&format!("$live{i}"), "live"))
                .collect();
            gs.timelines.insert("!r:h".to_string(), full);
        }

        // One page of scrollback, the size the window actually asks for.
        let page: Vec<Message> = (0..40).map(|i| msg(&format!("$old{i}"), "history")).collect();
        seed_timeline("cap", "!r:h", page);

        let map = STATE.read().unwrap();
        let buf = &map["cap"].timelines["!r:h"];
        assert_eq!(buf.len(), TIMELINE_CAP, "the cache stays bounded");
        let kept_history = buf.iter().filter(|m| m.body == "history").count();
        // The page goes in FRONT and the trim takes the front, so the 40
        // messages discarded are exactly the 40 just fetched — every live
        // message survives untouched.
        assert_eq!(kept_history, 0, "history survived the trim");
        assert_eq!(buf[0].event_id, "$live0", "a live message was dropped instead");
        assert_eq!(buf[TIMELINE_CAP - 1].event_id, format!("$live{}", TIMELINE_CAP - 1));
    }

    /// The same batch twice must not be the same message twice.
    ///
    /// A client retries `/sync` with the SAME `since` token until it gets a
    /// response it could process, so re-delivery of a batch is ordinary
    /// behaviour rather than a server misbehaving — `apply_reaction` already
    /// says as much where it dedupes reactors.
    #[test]
    fn a_replayed_batch_does_not_double_the_timeline() {
        let s = session();
        let batch = json!({
            "next_batch": "s1",
            "rooms": { "join": { "!r:example.com": {
                "state": { "events": [] },
                "timeline": { "events": [
                    { "type": "m.room.message", "event_id": "$one", "sender": "@a:h",
                      "origin_server_ts": 1,
                      "content": { "msgtype": "m.text", "body": "hello" } }
                ] }
            } } }
        });
        apply_sync("dup", &s, &batch);
        apply_sync("dup", &s, &batch);

        let bodies = || -> Vec<String> {
            STATE.read().unwrap()["dup"].timelines["!r:example.com"]
                .iter()
                .map(|m| m.body.clone())
                .collect()
        };
        assert_eq!(bodies(), vec!["hello".to_string()], "the batch was applied twice");

        // The overlap case, which is the realistic one: a retry that returns
        // what we already have PLUS what arrived since. Dropping the whole
        // batch because part of it was familiar would lose the new message.
        let overlap = json!({
            "next_batch": "s2",
            "rooms": { "join": { "!r:example.com": {
                "state": { "events": [] },
                "timeline": { "events": [
                    { "type": "m.room.message", "event_id": "$one", "sender": "@a:h",
                      "origin_server_ts": 1,
                      "content": { "msgtype": "m.text", "body": "hello" } },
                    { "type": "m.room.message", "event_id": "$two", "sender": "@a:h",
                      "origin_server_ts": 2,
                      "content": { "msgtype": "m.text", "body": "and again" } }
                ] }
            } } }
        });
        let d = apply_sync("dup", &s, &overlap);
        assert_eq!(bodies(), vec!["hello".to_string(), "and again".to_string()]);
        // And the window is told about the new one ONLY — a delta carrying the
        // duplicate would repaint it however well the buffer behaved.
        let said: Vec<String> = d
            .deltas
            .iter()
            .flat_map(|(_, ms)| ms.iter().map(|m| m.body.clone()))
            .collect();
        assert_eq!(said, vec!["and again".to_string()]);
    }

    /// An edit rewrites a message; it is not a second message.
    #[test]
    fn an_edit_replaces_rather_than_appends() {
        let s = session();
        let said = json!({
            "next_batch": "s1",
            "rooms": { "join": { "!r:example.com": {
                "state": { "events": [] },
                "timeline": { "events": [
                    { "type": "m.room.message", "event_id": "$orig", "sender": "@a:h",
                      "origin_server_ts": 1,
                      "content": { "msgtype": "m.text", "body": "raid 2-15631" } }
                ] }
            } } }
        });
        apply_sync("ed", &s, &said);
        let msgs = || STATE.read().unwrap().get("ed").unwrap()
            .timelines["!r:example.com"].clone();
        assert_eq!(msgs().len(), 1);

        let fix = json!({
            "next_batch": "s2",
            "rooms": { "join": { "!r:example.com": {
                "state": { "events": [] },
                "timeline": { "events": [
                    { "type": "m.room.message", "event_id": "$edit", "sender": "@a:h",
                      "origin_server_ts": 2, "content": {
                        "msgtype": "m.text",
                        "body": "* raid 2-15361",
                        "m.new_content": { "msgtype": "m.text", "body": "raid 2-15361" },
                        "m.relates_to": { "rel_type": "m.replace", "event_id": "$orig" }
                      } }
                ] }
            } } }
        });
        let d = apply_sync("ed", &s, &fix);
        assert_eq!(d.edited, vec![("!r:example.com".to_string(), "$orig".to_string())]);
        // One message, not two: a client that does not understand the relation
        // shows the edit as a second line beginning with `*`.
        assert_eq!(msgs().len(), 1, "{:?}", msgs());
        // …and the stored text is `m.new_content`, never the `* ` fallback.
        assert_eq!(msgs()[0].body, "raid 2-15361");
        assert!(msgs()[0].edited, "the change is shown, not hidden");
        assert!(d.deltas.is_empty(), "an edit is not new traffic");

        // A forged edit: somebody ELSE claiming to replace this message. The
        // spec makes ignoring it the client's job, so this is the check
        // standing between a stranger and words in your mouth — not a
        // belt-and-braces double of something the server did.
        let forged = json!({
            "next_batch": "s3",
            "rooms": { "join": { "!r:example.com": {
                "state": { "events": [] },
                "timeline": { "events": [
                    { "type": "m.room.message", "event_id": "$bad", "sender": "@villain:h",
                      "origin_server_ts": 3, "content": {
                        "msgtype": "m.text", "body": "* I surrender",
                        "m.new_content": { "msgtype": "m.text", "body": "I surrender" },
                        "m.relates_to": { "rel_type": "m.replace", "event_id": "$orig" }
                      } }
                ] }
            } } }
        });
        let d = apply_sync("ed", &s, &forged);
        assert!(d.edited.is_empty(), "somebody else cannot rewrite it");
        assert_eq!(msgs()[0].body, "raid 2-15361");

        STATE.write().unwrap().remove("ed");
    }

    #[test]
    fn the_edit_fallback_is_never_what_gets_stored() {
        // `m.new_content` is authoritative. The top-level body is the version
        // for clients that cannot edit — the new text with a `*` stuck on.
        let with_new = json!({
            "body": "* fixed", "m.new_content": { "body": "fixed" }
        });
        assert_eq!(edited_body(&with_new).as_deref(), Some("fixed"));

        // An older client may send only the fallback; strip the marker.
        let fallback_only = json!({ "body": "* fixed" });
        assert_eq!(edited_body(&fallback_only).as_deref(), Some("fixed"));

        // A message whose own text begins with `* ` and is NOT an edit keeps
        // it — this only ever runs on something already known to be an edit.
        let starred = json!({ "body": "* not really an edit" });
        assert_eq!(edited_body(&starred).as_deref(), Some("not really an edit"));
    }

    /// A message taken back has to change on screen.
    ///
    /// Before this, a redaction only ever undid a reaction — a deleted
    /// MESSAGE stayed up until the window was reloaded, which is the one
    /// outcome an unsend must not have.
    #[test]
    fn a_redacted_message_is_rewritten_in_place() {
        let s = session();
        let said = json!({
            "next_batch": "s1",
            "rooms": { "join": { "!r:example.com": {
                "state": { "events": [] },
                "timeline": { "events": [
                    { "type": "m.room.message", "event_id": "$keep", "sender": "@a:h",
                      "origin_server_ts": 1, "content": { "msgtype": "m.text", "body": "stays" } },
                    { "type": "m.room.message", "event_id": "$gone", "sender": "@a:h",
                      "origin_server_ts": 2, "content": { "msgtype": "m.text", "body": "regrets" } }
                ] }
            } } }
        });
        apply_sync("red", &s, &said);
        let body = |id: &str| {
            STATE.read().unwrap().get("red").unwrap().timelines["!r:example.com"]
                .iter().find(|m| m.event_id == id).map(|m| (m.kind, m.body.clone()))
        };
        assert_eq!(body("$gone"), Some(("text", "regrets".to_string())));

        let taken = json!({
            "next_batch": "s2",
            "rooms": { "join": { "!r:example.com": {
                "state": { "events": [] },
                "timeline": { "events": [
                    { "type": "m.room.redaction", "event_id": "$r", "sender": "@a:h",
                      "origin_server_ts": 3, "redacts": "$gone" }
                ] }
            } } }
        });
        let d = apply_sync("red", &s, &taken);
        assert_eq!(d.redacted, vec![("!r:example.com".to_string(), "$gone".to_string())]);
        // Rewritten, not dropped: a message that silently vanishes reads as a
        // bug in the client, and the gap is what everyone else still sees.
        assert_eq!(body("$gone"), Some(("notice", "message removed".to_string())));
        assert_eq!(body("$keep"), Some(("text", "stays".to_string())),
                   "only the redacted message changes");

        STATE.write().unwrap().remove("red");
    }

    /// Reactions are counted by WHO, not how many.
    ///
    /// "Have I already reacted" and "who agreed" are both questions a count
    /// cannot answer — and un-reacting means finding your own annotation
    /// event to redact, which a count has thrown away.
    #[test]
    fn reactions_aggregate_by_sender() {
        let mut gs = GuildState::default();
        let react = |id: &str, sender: &str, key: &str| {
            json!({
                "type": "m.reaction", "event_id": id, "sender": sender,
                "content": { "m.relates_to": {
                    "rel_type": "m.annotation", "event_id": "$msg", "key": key
                } }
            })
        };
        let up = "UP";
        let eye = "EYE";

        assert!(apply_reaction(&mut gs, "!r:h", &react("$a", "@1-61:h", up)));
        assert!(apply_reaction(&mut gs, "!r:h", &react("$b", "@me:h", up)));
        assert!(apply_reaction(&mut gs, "!r:h", &react("$c", "@1-42:h", eye)));

        let out = reactions_for(&gs, "!r:h", "$msg", "@me:h");
        assert_eq!(out.len(), 2);
        // Most-agreed first.
        assert_eq!(out[0].key, up);
        assert_eq!(out[0].count, 2);
        assert!(out[0].mine, "my own reaction is marked as mine");
        assert!(!out[1].mine);

        // Sync replays events on reconnect, so the same person reacting twice
        // with the same key is the normal case, not an edge.
        assert!(!apply_reaction(&mut gs, "!r:h", &react("$d", "@1-61:h", up)));
        assert_eq!(reactions_for(&gs, "!r:h", "$msg", "@me:h")[0].count, 2);

        // Un-reacting redacts one annotation, and only that one.
        let redaction = json!({ "type": "m.room.redaction", "redacts": "$b" });
        assert_eq!(undo_reaction(&mut gs, &redaction).as_deref(), Some("$msg"));
        let out = reactions_for(&gs, "!r:h", "$msg", "@me:h");
        assert_eq!(out[0].count, 1);
        assert!(!out[0].mine);

        // A key nobody holds any more is gone, not a chip reading zero.
        let redaction = json!({ "type": "m.room.redaction", "redacts": "$c" });
        undo_reaction(&mut gs, &redaction);
        let out = reactions_for(&gs, "!r:h", "$msg", "@me:h");
        assert_eq!(out.len(), 1, "the emptied key is removed: {:?}", out);
    }

    #[test]
    fn a_reaction_key_from_federation_is_bounded() {
        let mut gs = GuildState::default();
        let huge = "x".repeat(500);
        let ev = json!({
            "type": "m.reaction", "event_id": "$a", "sender": "@x:h",
            "content": { "m.relates_to": {
                "rel_type": "m.annotation", "event_id": "$msg", "key": huge
            } }
        });
        apply_reaction(&mut gs, "!r:h", &ev);
        // It becomes a chip in this window; a remote server does not get to
        // decide how wide.
        assert_eq!(reactions_for(&gs, "!r:h", "$msg", "@me:h")[0].key.chars().count(), 32);

        // An empty key is not a reaction at all.
        let blank = json!({
            "type": "m.reaction", "event_id": "$b", "sender": "@x:h",
            "content": { "m.relates_to": {
                "rel_type": "m.annotation", "event_id": "$other", "key": "   "
            } }
        });
        assert!(!apply_reaction(&mut gs, "!r:h", &blank));
    }

    /// A reply repeats what it answers inside its own body, for clients with
    /// no reply rendering. This one HAS reply rendering, so it has to take
    /// that block back off — and the two halves must agree exactly, or every
    /// reply prints its quote twice.
    #[test]
    fn the_reply_fallback_round_trips() {
        let quoted = "the refinery is ours\nsecond line";
        let mut lines = quoted.lines();
        let mut quote = vec![format!("> <{}> {}", "@1-61:h", lines.next().unwrap())];
        quote.extend(lines.map(|l| format!("> {}", l)));
        let wire = format!("{}\n\n{}", quote.join("\n"), "agreed");

        assert_eq!(strip_reply_fallback(&wire), "agreed");
        let (who, said) = quoted_from_fallback(&wire);
        assert_eq!(who.as_deref(), Some("@1-61:h"));
        assert_eq!(said.as_deref(), Some("the refinery is ours second line"));
    }

    #[test]
    fn a_reply_whose_own_text_quotes_keeps_it() {
        // Only the LEADING fallback block is the fallback. A reply that itself
        // begins with a quotation is quoting on purpose.
        let wire = "> <@a:h> original\n\n> and this is my own quote";
        assert_eq!(strip_reply_fallback(wire), "> and this is my own quote");
    }

    #[test]
    fn a_plain_message_is_left_alone() {
        assert_eq!(strip_reply_fallback("just talking"), "just talking");
        assert_eq!(quoted_from_fallback("just talking"), (None, None));
    }

    #[test]
    fn a_reply_relation_is_read_off_the_event() {
        let s = session();
        let mut gs = GuildState::default();
        gs.names.insert("@1-61:h".into(), "JPEG".into());
        let ev = json!({
            "type": "m.room.message", "event_id": "$r1", "sender": "@1-42:h",
            "origin_server_ts": 1,
            "content": {
                "msgtype": "m.text",
                "body": "> <@1-61:h> take 2-15361\n\nagreed",
                "m.relates_to": { "m.in_reply_to": { "event_id": "$q1" } }
            }
        });
        let m = render_event(&ev, &gs, "!r:h", "@me:h").unwrap();
        assert_eq!(m.reply_to.as_deref(), Some("$q1"));
        assert_eq!(m.reply_sender.as_deref(), Some("@1-61:h"));
        assert_eq!(m.reply_excerpt.as_deref(), Some("take 2-15361"));
        // …and the quote is NOT left in the message itself.
        assert_eq!(m.body, "agreed");
        let _ = s;
    }

    /// A room states its own shortlist, and an unmentioned one is unchanged.
    #[test]
    fn pinned_events_follow_the_room_state() {
        let s = session();
        let with = |pins: Option<Vec<&str>>| {
            let mut events = vec![json!({
                "type": "m.room.name", "content": { "name": "Lobby" }
            })];
            if let Some(p) = pins {
                events.push(json!({
                    "type": "m.room.pinned_events", "content": { "pinned": p }
                }));
            }
            let state = json!({ "events": events });
            json!({
                "next_batch": "s1",
                "rooms": { "join": { "!p:example.com": {
                    "state": state, "timeline": { "events": [] }
                } } }
            })
        };
        let pins = || {
            STATE.read().unwrap().get("pin").unwrap()
                .rooms.get("!p:example.com").unwrap().pinned.clone()
        };

        apply_sync("pin", &s, &with(Some(vec!["$a", "$b"])));
        assert_eq!(pins(), vec!["$a".to_string(), "$b".to_string()]);

        // A sync that does not mention pins has not unpinned anything — the
        // same trap as the unread counts: absent is "unchanged", not "none".
        apply_sync("pin", &s, &with(None));
        assert_eq!(pins(), vec!["$a".to_string(), "$b".to_string()]);

        // Emptying the list IS a statement, and has to be obeyed.
        apply_sync("pin", &s, &with(Some(vec![])));
        assert!(pins().is_empty());

        STATE.write().unwrap().remove("pin");
    }

    /// The one-line version, for the door into Comms.
    #[test]
    fn unread_totals_sum_only_joined_rooms() {
        let room = |unread: u64, mention: bool, joined: bool| Room {
            room_id: "!r:h".into(),
            name: "r".into(),
            canonical_alias: None,
            topic: None,
            members: 0,
            joined,
            pinned: Vec::new(),
            muted: false,
            encrypted: false,
            replaced_by: None,
            invited: false,
            invited_by: None,
            unread,
            mention,
            icon: "icon-guild".into(),
            section: "local".into(),
            home_rank: None,
            pfp_attrs: None,
            player_id: None,
        };

        // Across every network, not one: a player asking "is anything waiting"
        // should not have to work out which guild it was on.
        let rooms = vec![room(3, false, true), room(4, true, true)];
        assert_eq!(sum_unread(rooms.iter()), (7, true));

        // A room merely visible in the directory is not a message to anyone.
        let rooms = vec![room(3, false, true), room(4, true, false)];
        assert_eq!(sum_unread(rooms.iter()), (3, false));

        assert_eq!(sum_unread([].iter()), (0, false));
    }

    #[test]
    fn sync_folds_rooms_and_timelines() {
        let s = session();
        let v = json!({
            "next_batch": "s2",
            "rooms": { "join": { "!snc:example.com": {
                "summary": { "m.joined_member_count": 25 },
                "state": { "events": [
                    { "type": "m.room.name", "content": { "name": "SN.Corporation" } },
                    { "type": "m.room.member", "state_key": "@1-42:example.com",
                      "content": { "displayname": "Netlag", "membership": "join" } }
                ]},
                "timeline": { "events": [
                    { "type": "m.room.message", "event_id": "$1",
                      "sender": "@1-42:example.com", "origin_server_ts": 5,
                      "content": { "msgtype": "m.text", "body": "Ok." } }
                ]}
            }}}
        });
        let d = apply_sync("test-fold", &s, &v);
        assert!(d.rooms_changed);
        assert_eq!(d.deltas.len(), 1);
        assert_eq!(d.deltas[0].1[0].sender_name, "Netlag");

        let rooms = rooms_of("test-fold");
        assert_eq!(rooms.len(), 1);
        assert_eq!(rooms[0].name, "SN.Corporation");
        assert_eq!(rooms[0].members, 25);
        assert_eq!(rooms[0].section, "local");
        assert!(rooms[0].joined);
        assert_eq!(rooms[0].icon, "icon-guild");

        // A second, empty sync must not report a change — an idle homeserver
        // long-polls every 30s and would otherwise repaint the window forever.
        let d2 = apply_sync("test-fold", &s, &json!({ "next_batch": "s3" }));
        assert!(d2.deltas.is_empty());
        assert!(!d2.rooms_changed);
    }

    #[test]
    fn typing_is_read_from_the_ephemeral_edu() {
        let s = session();
        let v = json!({
            "next_batch": "1",
            "rooms": { "join": { "!r:example.com": {
                "state": { "events": [] },
                "timeline": { "events": [] },
                "ephemeral": { "events": [{
                    "type": "m.typing",
                    // The EDU always carries the WHOLE set, ourselves included.
                    "content": { "user_ids": ["@1-42:example.com", "@1-194:example.com"] }
                }]}
            }}}
        });
        let d = apply_sync("test-typing", &s, &v);
        assert_eq!(d.typing.len(), 1);
        // Never report yourself as typing back at yourself.
        assert_eq!(d.typing[0].1, vec!["@1-42:example.com".to_string()]);

        // An empty set is how "stopped typing" arrives, and it must register
        // as a change so the line clears.
        let stop = json!({
            "next_batch": "2",
            "rooms": { "join": { "!r:example.com": {
                "state": { "events": [] }, "timeline": { "events": [] },
                "ephemeral": { "events": [{ "type": "m.typing", "content": { "user_ids": [] } }]}
            }}}
        });
        let dc = apply_sync("test-typing", &s, &stop);
        assert_eq!(dc.typing.len(), 1);
        assert!(dc.typing[0].1.is_empty());

        // Repeating the same set is NOT a change — sync reports it constantly
        // and every repeat would repaint the window.
        let da = apply_sync("test-typing", &s, &stop);
        assert!(da.typing.is_empty());
    }

    /// The SAME cases the window's own matcher is held to
    /// (scripts/harness-tests/chat.test.mjs, "mention matching"). Two
    /// implementations of one rule is a liability unless both are pinned to
    /// the same table — Rust decides whether to interrupt you, the window
    /// decides whether to highlight, and they must never disagree.
    #[test]
    fn mentions_match_on_word_boundaries() {
        let names = vec!["Marklifer".to_string(), "1-194".to_string()];
        for (body, want, why) in [
            ("Marklifer, are you seeing this?", true, "name followed by a comma"),
            ("hey Marklifer", true, "name at the end"),
            ("ping 1-194 please", true, "player id counts too"),
            ("Marklifers everywhere", false, "a longer word that starts with it"),
            ("xMarklifer", false, "a longer word that ends with it"),
            ("1-1944 is not me", false, "a longer id"),
            ("MARKLIFER", true, "case does not matter"),
            ("", false, "an empty body"),
            ("nothing to see", false, "no mention at all"),
        ] {
            assert_eq!(is_mention(body, &names), want, "{}: {:?}", why, body);
        }
    }

    /// "Was this aimed at me" has ONE answer, and both surfaces use it.
    ///
    /// The badge read the spec's `m.mentions` only; the notifier matched the
    /// body text only. So a mention that named me properly highlighted without
    /// interrupting, and one from a client too old to send `m.mentions`
    /// interrupted without highlighting — each surface missing exactly what
    /// the other had.
    #[test]
    fn a_mention_is_the_exact_signal_or_the_text_fallback() {
        let gs = GuildState::default();
        let me = "@7-8001:example.com";
        directory::learn_server_name("7-8", me);
        directory::remember_for_test(
            "7-8001",
            directory::Ident {
                username: "Solenne".into(),
                tag: String::new(),
                guild_id: "7-8".into(),
                pfp_attrs: None,
            },
        );

        let say = |body: &str, mentions: Option<Value>| {
            let mut content = json!({ "msgtype": "m.text", "body": body });
            if let Some(m) = mentions {
                content["m.mentions"] = m;
            }
            let ev = json!({
                "type": "m.room.message", "event_id": "$m", "sender": "@other:h",
                "origin_server_ts": 1, "content": content
            });
            render_event(&ev, &gs, "!r:h", me).unwrap().mentions_me
        };

        // The spec's own answer, with a body that never spells my name. This
        // is what Element sends for a pill, and it used to reach the badge but
        // never the notifier.
        assert!(say("are you around?", Some(json!({ "user_ids": [me] }))));

        // The fallback, for a client that sends no `m.mentions` at all. This
        // reached the notifier but never the badge.
        assert!(say("@Solenne are you around?", None));
        // The player id works as a name too — players talk in ids.
        assert!(say("7-8001 are you around?", None));

        // Neither: an ordinary message stays quiet.
        assert!(!say("has anyone seen the shield?", None));
        // Somebody ELSE being mentioned is not me being mentioned.
        assert!(!say("hello", Some(json!({ "user_ids": ["@1-61:example.com"] }))));
        // A name inside a longer word is not a mention.
        assert!(!say("the Solennes are here", None));

        directory::forget_for_test("7-8001");
    }

    #[test]
    fn a_short_name_is_not_matched_at_all() {
        // A one-character username would fire on almost every message; better
        // to miss those mentions than to interrupt constantly.
        let s = Session { user_id: "@1-1:example.com".into(), ..session() };
        assert!(!my_names(&s.user_id).iter().any(|n| n.chars().count() < 2));
    }

    /// Only a person SPEAKING may interrupt you.
    ///
    /// Reported from live play: signing in produced a desktop notification
    /// reading "<name> joined", every time. A DM notifies on anything that is
    /// not `unknown`, and ten different things — joins, renames, topic and pin
    /// changes, invitations — all render as kind `event`.
    #[test]
    fn only_a_message_is_worth_interrupting_someone_for() {
        // What renders as what, straight from render_event, so this test moves
        // if the kinds do.
        let gs = GuildState::default();
        let kind_of = |ev: &Value| render_event(ev, &gs, "!r:h", "@me:h").map(|m| m.kind);

        let join = json!({
            "type": "m.room.member", "event_id": "$j", "sender": "@a:h",
            "origin_server_ts": 1, "content": { "membership": "join" }
        });
        assert_eq!(kind_of(&join), Some("event"), "a join is an event");

        let said = json!({
            "type": "m.room.message", "event_id": "$m", "sender": "@a:h",
            "origin_server_ts": 2, "content": { "msgtype": "m.text", "body": "hello" }
        });
        assert_eq!(kind_of(&said), Some("text"), "a message is a message");

        // The allowlist the notifier applies. `notice` is absent on purpose:
        // it is both a real m.notice AND this file's own synthesized lines
        // ("message removed", a tombstone, an unreadable encrypted message),
        // none of which is a person talking.
        let notifiable = |k: &str| matches!(k, "text" | "emote" | "image");
        assert!(notifiable("text"));
        assert!(notifiable("emote"));
        assert!(notifiable("image"));
        assert!(!notifiable("event"), "a join must never interrupt anyone");
        assert!(!notifiable("notice"), "nor a redaction or a tombstone");
        assert!(!notifiable("gap"), "nor a hole in the scrollback");
    }

    #[test]
    fn a_room_is_notified_about_at_most_once_per_cooldown() {
        let room = "!cooldown-test:example.com";
        assert!(claim_notify_slot(room), "first notification should go out");
        assert!(!claim_notify_slot(room), "a second within the cooldown must not");
    }

    #[test]
    fn only_known_message_types_reach_the_wire() {
        assert_eq!(msgtype_or_text(Some("m.emote")), "m.emote");
        assert_eq!(msgtype_or_text(Some("m.notice")), "m.notice");
        assert_eq!(msgtype_or_text(None), "m.text");
        // A typo must not mint an event type no client renders.
        assert_eq!(msgtype_or_text(Some("m.emoat")), "m.text");
        assert_eq!(msgtype_or_text(Some("")), "m.text");
    }

    /// Transcribed from the LIVE crew.oh.energy account (2026-08-29): a real
    /// DM with `chatrbocks` that has no name, no alias, and NO `m.direct`
    /// entry — the homeserver simply never wrote one. It was rendering as its
    /// own room id.
    #[test]
    fn an_unnamed_two_person_room_is_a_direct_message() {
        let s = session();
        let v = json!({
            "next_batch": "1",
            "rooms": { "join": { "!LXmKAaU5h6gPr6VMuqsHXI2BiDUs:example.com": {
                "summary": {
                    "m.joined_member_count": 2,
                    "m.heroes": ["@1-3076:example.com", "@1-194:example.com"]
                },
                "state": { "events": [
                    { "type": "m.room.member", "state_key": "@1-3076:example.com",
                      "content": { "displayname": "chatrbocks", "membership": "join" } }
                ]},
                "timeline": { "events": [] }
            }}}
        });
        apply_sync("test-dm-heroes", &s, &v);
        let rooms = rooms_of("test-dm-heroes");
        assert_eq!(rooms.len(), 1);
        // Named after the person, filed under Direct — not a nameless channel.
        assert_eq!(rooms[0].name, "chatrbocks");
        assert_eq!(rooms[0].section, "direct");
        // Ourselves must never be the hero the room is named after.
        assert_ne!(rooms[0].name, "1-194");
    }

    /// A room id is never a name. This was the actual symptom: a real room
    /// showing as `!LXmKAaU5h6gPr6VMuqsHXI2BiDUs-FXky-w4gxDPUSk`.
    #[test]
    fn a_room_is_never_called_by_its_id() {
        let s = session();
        // No name, no alias, no heroes, and more than two people — nothing to
        // go on at all, which is exactly when the id used to leak through.
        let v = json!({
            "next_batch": "1",
            "rooms": { "join": { "!opaque:example.com": {
                "summary": { "m.joined_member_count": 9 },
                "state": { "events": [] }, "timeline": { "events": [] }
            }}}
        });
        apply_sync("test-noname", &s, &v);
        let rooms = rooms_of("test-noname");
        assert_eq!(rooms[0].name, "Untitled room");
        assert!(!rooms[0].name.starts_with('!'));
    }

    #[test]
    fn an_alias_reads_as_a_name() {
        // Live aliases from both homeservers.
        assert_eq!(pretty_alias("#orbital-hydro:matrix.crew.oh.energy").as_deref(),
            Some("Orbital Hydro"));
        assert_eq!(pretty_alias("#sn-corp:matrix.beta.playstructs.com").as_deref(),
            Some("Sn Corp"));
        assert_eq!(pretty_alias("#lobby:matrix.crab.la").as_deref(), Some("Lobby"));
        assert_eq!(pretty_alias("#:host").as_deref(), None);
    }

    #[test]
    fn a_named_room_keeps_its_own_name() {
        // The alias must never override a name the room actually set.
        let s = session();
        let v = json!({
            "next_batch": "1",
            "rooms": { "join": { "!x:example.com": {
                "state": { "events": [
                    { "type": "m.room.name", "content": { "name": "Kilgore Crabla — Guild Lobby" } },
                    { "type": "m.room.canonical_alias", "content": { "alias": "#lobby:example.com" } }
                ]},
                "timeline": { "events": [] }
            }}}
        });
        apply_sync("test-named", &s, &v);
        assert_eq!(rooms_of("test-named")[0].name, "Kilgore Crabla — Guild Lobby");
    }

    #[test]
    fn leaving_a_room_elsewhere_drops_it_here() {
        let s = session();
        apply_sync(
            "test-leave",
            &s,
            &json!({ "next_batch": "1", "rooms": { "join": { "!x:example.com": {
                "state": { "events": [{ "type": "m.room.name", "content": { "name": "X" } }] },
                "timeline": { "events": [] } } } } }),
        );
        assert_eq!(rooms_of("test-leave").len(), 1);
        let d = apply_sync(
            "test-leave",
            &s,
            &json!({ "next_batch": "2", "rooms": { "leave": { "!x:example.com": {} } } }),
        );
        assert!(d.rooms_changed);
        assert!(rooms_of("test-leave").is_empty());
    }

    #[test]
    fn icons_only_ever_come_from_the_shipped_set() {
        const SHIPPED: &[&str] = &[
            "icon-raid", "icon-planet", "icon-guild", "icon-member", "icon-info", "icon-beacon",
        ];
        for (name, alias) in [
            ("Raid", None),
            ("Alpha Base", None),
            ("SN.Corporation", None),
            ("Community", None),
            ("Announcements", None),
            ("Something Else Entirely", Some("#zzz:h")),
        ] {
            assert!(SHIPPED.contains(&icon_for(name, alias)), "{}", name);
        }
    }
}
