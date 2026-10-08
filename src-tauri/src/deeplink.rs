//! `structs://` links — the desktop half of the structs.app link grammar.
//!
//! The grammar is structs-app's `src/links.js` (human version:
//! `structs-app/docs/links.md`), ported here so a link means the same thing on
//! the web and in the app:
//!
//!   structs://sim/<code>[/<result>]     the simulator, with that battle loaded
//!   structs://map/<planet|fleet>        the map viewer on it
//!   structs://map/<player>              the map viewer on their home planet
//!   structs://<view>/<id>               the Terminal line `VIEW id` — PLAYER,
//!                                       RECORD, TALLY, PROVIDER, REACTOR
//!   structs://<id>                      the id's default view
//!   structs://                          the main window
//!
//! Both orders work (`/1-61/record`), and so do the Terminal's aliases
//! (`awards`, `hulls`, `profile`…). Ids are matched whole: `1-195` is never
//! `1-1950`. A `https://structs.app/…` URL parses too, so a pasted web link
//! means the same thing.
//!
//! Delivery: `tauri-plugin-deep-link` hands every opened URL to `handle`;
//! on Windows/Linux `tauri-plugin-single-instance` forwards a second launch's
//! URL to the running app first.

use tauri::Manager;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Link {
    Home,
    Sim { code: String },
    View { view: &'static str, id: String, kind: &'static str },
}

/// Object type prefixes — structs-webapp `ObjectTypes`.
fn kind_of(id: &str) -> Option<&'static str> {
    let (prefix, rest) = id.split_once('-')?;
    if prefix.is_empty() || prefix.len() > 2 || rest.is_empty() || rest.len() > 12 { return None; }
    if !prefix.bytes().all(|b| b.is_ascii_digit()) || !rest.bytes().all(|b| b.is_ascii_digit()) { return None; }
    Some(match prefix.parse::<u32>().ok()? {
        0 => "guild", 1 => "player", 2 => "planet", 3 => "reactor", 4 => "substation",
        5 => "struct", 9 => "fleet", 10 => "provider",
        _ => return None,
    })
}

/// view → the kinds it accepts and its Terminal word.
fn view_spec(view: &str) -> Option<(&'static str, &'static [&'static str], &'static str)> {
    Some(match view {
        "player" => ("player", &["player"], "PLAYER"),
        "map" => ("map", &["planet", "fleet", "player"], "MAP"),
        "record" => ("record", &["player"], "RECORD"),
        "tally" => ("tally", &["player"], "TALLY"),
        "provider" => ("provider", &["provider"], "PROVIDER"),
        "reactor" => ("reactor", &["reactor"], "REACTOR"),
        _ => return None,
    })
}

fn view_name(word: &str) -> Option<&'static str> {
    let w = word.to_ascii_lowercase();
    if let Some((v, _, _)) = view_spec(&w) { return Some(v); }
    Some(match w.as_str() {
        "p" | "profile" => "player",
        "awards" | "achievements" => "record",
        "hulls" | "kills" => "tally",
        "planet" | "fleet" => "map",
        _ => return None,
    })
}

fn default_view(kind: &str) -> Option<&'static str> {
    Some(match kind {
        "player" => "player", "planet" | "fleet" => "map", "provider" => "provider", "reactor" => "reactor",
        _ => return None,
    })
}

fn is_code(s: &str) -> bool {
    (4..=2000).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn pct_decode(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let hex = s.get(i + 1..i + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// A `structs://` URL (or a structs.app URL, or a bare path) → a link.
pub fn parse(input: &str) -> Option<Link> {
    let mut s = input.trim();
    let lower = s.to_ascii_lowercase();
    if lower.starts_with("structs://") {
        s = &s["structs://".len()..];
    } else if let Some(rest) = lower.strip_prefix("https://").or_else(|| lower.strip_prefix("http://")) {
        let skip = s.len() - rest.len();
        let host_end = rest.find('/').unwrap_or(rest.len());
        let host = &rest[..host_end];
        if host != "structs.app" && host != "www.structs.app" { return None; }
        s = &s[skip + host_end..];
    }
    let s = s.split(['?', '#']).next().unwrap_or("");
    let parts: Vec<String> = s.split('/').filter(|p| !p.is_empty()).map(|p| pct_decode(p).unwrap_or_default()).collect();
    if parts.is_empty() { return Some(Link::Home); }

    if parts[0].eq_ignore_ascii_case("sim") {
        // /sim/<code>, and the proposed /sim/<code>/<result>: a result link
        // opens the battle it was played on.
        // /sim/<code>, and /sim/<code>/<result>: a result link opens the
        // battle it was played on, and a malformed result never loses the
        // battle (structs-app links.js, same rule).
        let ok = is_code(&parts[1]) && (parts.len() == 2 || parts.len() == 3);
        return ok.then(|| Link::Sim { code: parts[1].clone() });
    }
    if parts.len() > 2 { return None; }

    let (id, word) = match parts.len() {
        1 => (parts[0].as_str(), None),
        _ if kind_of(&parts[0]).is_some() => (parts[0].as_str(), Some(parts[1].as_str())),
        _ => (parts[1].as_str(), Some(parts[0].as_str())),
    };
    let kind = kind_of(id)?;
    let view = match word { None => default_view(kind)?, Some(w) => view_name(w)? };
    let (view, kinds, _) = view_spec(view)?;
    if !kinds.contains(&kind) { return None; }
    Some(Link::View { view, id: id.to_string(), kind })
}

/// The Terminal line for a view link — what typing it would run.
pub fn terminal_line(view: &str, id: &str) -> Option<String> {
    view_spec(view).map(|(_, _, word)| format!("{word} {id}"))
}

/// Do what a link says — off the main thread.
///
/// macOS delivers a link as an Apple Event, and the deep-link plugin calls
/// back from INSIDE that event on the main thread. Building a window there
/// waits on the main thread's own event loop, which is busy running this
/// callback: the app froze for good (sampled 2026-10-08 — main thread parked
/// in WebviewWindowBuilder::build under deeplink::handle). So the callback
/// only queues the link; a background task opens the windows, and Tauri
/// marshals each build onto the main thread once it is free again.
pub fn handle(app: &tauri::AppHandle, url: &str) {
    let app = app.clone();
    let url = url.to_string();
    tauri::async_runtime::spawn(async move { dispatch(&app, &url) });
}

fn dispatch(app: &tauri::AppHandle, url: &str) {
    let Some(link) = parse(url) else {
        eprintln!("[deeplink] not a Structs link: {url}");
        return;
    };
    let result = match &link {
        Link::Home => {
            if let Some(w) = app.get_webview_window("main") { let _ = w.unminimize(); let _ = w.set_focus(); }
            Ok(())
        }
        Link::Sim { code } => crate::simulator::open_battle(app, code),
        Link::View { view: "map", id, kind } => open_map(app, id, kind),
        Link::View { view, id, .. } => match terminal_line(view, id) {
            Some(line) => crate::mcp::terminal::run_line(app, &line),
            None => Err(format!("no Terminal word for {view}")),
        },
    };
    if let Err(e) = result {
        eprintln!("[deeplink] {url}: {e}");
    }
}

/// The map viewer, straight — no Terminal needed for a planet or a fleet. A
/// player's map is their home planet, read from the chain's player record.
fn open_map(app: &tauri::AppHandle, id: &str, kind: &str) -> Result<(), String> {
    use crate::mcp::raid_view::{open_window, parse_target};
    match kind {
        "planet" => open_window(app, &parse_target(Some(id), None)?).map(|_| ()),
        "fleet" => open_window(app, &parse_target(None, Some(id))?).map(|_| ()),
        _ => {
            let app = app.clone();
            let id = id.to_string();
            tauri::async_runtime::spawn(async move {
                let planet = crate::mcp::tools::board_pages::mcp_player_profile(id.clone()).await.ok().and_then(|v| {
                    let e = &v["entity"];
                    e["planetId"].as_str().or_else(|| e["planet_id"].as_str()).or_else(|| v["planet_id"].as_str()).map(String::from)
                });
                let r = match planet.filter(|p| kind_of(p) == Some("planet")) {
                    Some(p) => parse_target(Some(&p), None).and_then(|t| open_window(&app, &t).map(|_| ())),
                    None => Err(format!("{id} has no planet")),
                };
                if let Err(e) = r { eprintln!("[deeplink] map/{id}: {e}"); }
            });
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn canon(p: &str) -> Option<String> {
        parse(p).map(|l| match l {
            Link::Home => "/".into(),
            Link::Sim { code } => format!("/sim/{code}"),
            Link::View { view, id, .. } => format!("/{view}/{id}"),
        })
    }

    // The same cases as structs-app/test/links.test.js.
    #[test]
    fn a_bare_id_opens_its_kinds_default_view() {
        assert_eq!(canon("structs://1-61").as_deref(), Some("/player/1-61"));
        assert_eq!(canon("structs://2-21740").as_deref(), Some("/map/2-21740"));
        assert_eq!(canon("structs://9-61").as_deref(), Some("/map/9-61"));
        assert_eq!(canon("structs://10-1").as_deref(), Some("/provider/10-1"));
        assert_eq!(canon("structs://3-1").as_deref(), Some("/reactor/3-1"));
    }

    #[test]
    fn both_orders_and_aliases_are_the_same_link() {
        assert_eq!(canon("structs://1-61/map"), canon("structs://map/1-61"));
        assert_eq!(canon("structs://1-61/record").as_deref(), Some("/record/1-61"));
        assert_eq!(canon("structs://awards/1-61").as_deref(), Some("/record/1-61"));
        assert_eq!(canon("structs://1-61/achievements").as_deref(), Some("/record/1-61"));
        assert_eq!(canon("structs://hulls/1-61").as_deref(), Some("/tally/1-61"));
        assert_eq!(canon("structs://profile/1-61").as_deref(), Some("/player/1-61"));
        assert_eq!(canon("structs://MAP/1-61").as_deref(), Some("/map/1-61"));
    }

    #[test]
    fn a_view_refuses_kinds_it_cannot_show() {
        for bad in ["structs://record/2-5", "structs://map/10-1", "structs://provider/1-61", "structs://5-100",
                    "structs://1-61/map/extra", "structs://nope", "structs://map/1-61x", "structs://map/123-1"] {
            assert_eq!(parse(bad), None, "{bad}");
        }
    }

    #[test]
    fn ids_are_matched_whole_never_by_prefix() {
        assert_eq!(canon("structs://player/1-1950").as_deref(), Some("/player/1-1950"));
        assert_ne!(canon("structs://player/1-1950"), canon("structs://player/1-195"));
    }

    #[test]
    fn web_links_and_sim_links_parse_too() {
        assert_eq!(canon("https://structs.app/record/1-61?x=1#y").as_deref(), Some("/record/1-61"));
        assert_eq!(parse("https://evil.example/record/1-61"), None);
        assert_eq!(parse("structs://sim/AQQJCQ"), Some(Link::Sim { code: "AQQJCQ".into() }));
        assert_eq!(parse("structs://sim/AQQJCQ/AQABAGEAwgIOEwMCBQQMCwEBBA"), Some(Link::Sim { code: "AQQJCQ".into() }));
        assert_eq!(parse("structs://sim/AQQJCQ/not!a!result"), Some(Link::Sim { code: "AQQJCQ".into() }));
        assert_eq!(parse("structs://sim/AQQJCQ/r/extra"), None);
        assert_eq!(parse("structs://sim/AQ'Q;JCQ"), None);
        assert_eq!(parse("structs://"), Some(Link::Home));
    }

    #[test]
    fn terminal_lines_match_the_site() {
        assert_eq!(terminal_line("record", "1-61").as_deref(), Some("RECORD 1-61"));
        assert_eq!(terminal_line("provider", "10-1").as_deref(), Some("PROVIDER 10-1"));
        assert_eq!(terminal_line("reactor", "3-1").as_deref(), Some("REACTOR 3-1"));
    }
}
