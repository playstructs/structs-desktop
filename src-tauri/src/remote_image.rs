//! Remote images, fetched by Rust and handed to the window as data URIs.
//!
//! The app's CSP is `img-src 'self' data: blob:` — no `http:`, no `https:` —
//! so anything the page points at a remote host renders blank. That is not an
//! oversight. A guild's logo URL is GUILD-AUTHORED: it comes from
//! `guild_meta.logo`, published in each guild's own `guild.json`, and it does
//! not have to live anywhere near that guild's API. Two live examples:
//!
//!   SN Corp        https://beta.playstructs.com/img/logo-snc.gif
//!   Orbital Hydro  https://oh.energy/images/logo.svg     (not crew.oh.energy)
//!
//! Letting the window load those directly would tell an arbitrary host, chosen
//! by another player, who is browsing the guild directory and when. So the
//! bytes come through here instead — the same answer chat images already use
//! (`matrix_media`), and the reason the CSP can stay shut.
//!
//! Fetching a URL somebody else chose is its own hazard, so this is deliberately
//! narrow: https only, no private or loopback host (this app's own MCP server
//! listens on 127.0.0.1:8420), a byte cap, a timeout, and the response must
//! actually be an image.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{LazyLock, RwLock};

/// Big enough for a logo, small enough that a hostile host cannot use us to
/// fill memory. Enforced against the declared length AND the bytes actually
/// read, because `content-length` is a claim, not a fact.
const MAX_BYTES: usize = 512 * 1024;
const TIMEOUT_SECS: u64 = 6;
/// Distinct URLs remembered. The guild directory is a few dozen rows.
const CACHE_CAP: usize = 64;

static CACHE: LazyLock<RwLock<HashMap<String, Value>>> =
    LazyLock::new(|| RwLock::new(HashMap::new()));

/// Is this host one we must never be talked into fetching?
///
/// Whole-host checks and parsed IPs — never a substring test. `evil.com` can
/// name itself `localhost.evil.com`, and a DNS name can resolve to a private
/// address, which is why the resolved socket addresses are checked too.
fn host_is_private(host: &str) -> bool {
    use std::net::{IpAddr, ToSocketAddrs};
    let bare = host.trim_end_matches('.').to_ascii_lowercase();
    if bare == "localhost" || bare.ends_with(".localhost") || bare.ends_with(".local") {
        return true;
    }
    // Literal IP in the URL, or whatever the name resolves to.
    let addrs: Vec<IpAddr> = match bare.parse::<IpAddr>() {
        Ok(ip) => vec![ip],
        Err(_) => (bare.as_str(), 443u16)
            .to_socket_addrs()
            .map(|it| it.map(|s| s.ip()).collect())
            .unwrap_or_default(),
    };
    if addrs.is_empty() {
        // A name we cannot resolve is not a name we should fetch.
        return true;
    }
    addrs.iter().any(|ip| match ip {
        IpAddr::V4(v4) => {
            v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_broadcast()
                || v4.is_unspecified()
                || v4.octets()[0] == 0
                // Carrier-grade NAT, 100.64.0.0/10.
                || (v4.octets()[0] == 100 && (64..=127).contains(&v4.octets()[1]))
        }
        IpAddr::V6(v6) => {
            v6.is_loopback()
                || v6.is_unspecified()
                // Unique-local fc00::/7 and link-local fe80::/10.
                || (v6.segments()[0] & 0xfe00) == 0xfc00
                || (v6.segments()[0] & 0xffc0) == 0xfe80
        }
    })
}

/// Reject before opening a socket. Returns the reason, so the window can say
/// what happened rather than showing an empty box.
pub fn refuse_reason(url: &str) -> Option<String> {
    let parsed = match reqwest::Url::parse(url) {
        Ok(u) => u,
        Err(e) => return Some(format!("not a URL: {e}")),
    };
    if parsed.scheme() != "https" {
        return Some(format!("{} is not https", parsed.scheme()));
    }
    match parsed.host_str() {
        None => Some("no host".into()),
        Some(h) if host_is_private(h) => Some(format!("{h} is not a public host")),
        Some(_) => None,
    }
}

/// Fetch `url` and return `{ data_url, mime }`.
#[tauri::command]
pub async fn remote_image(url: String) -> Result<Value, String> {
    if let Some(hit) = CACHE.read().ok().and_then(|c| c.get(&url).cloned()) {
        return Ok(hit);
    }
    if let Some(why) = refuse_reason(&url) {
        return Err(why);
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(TIMEOUT_SECS))
        // A redirect is a second URL somebody else chose; re-check it.
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 3 {
                return attempt.error("too many redirects");
            }
            match refuse_reason(attempt.url().as_str()) {
                Some(_) => attempt.stop(),
                None => attempt.follow(),
            }
        }))
        .build()
        .map_err(|e| e.to_string())?;

    let res = client.get(&url).send().await.map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("{}", res.status()));
    }
    let mime = res
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    if !mime.starts_with("image/") {
        return Err(format!("not an image ({})", if mime.is_empty() { "no type" } else { &mime }));
    }
    if res.content_length().is_some_and(|n| n as usize > MAX_BYTES) {
        return Err("image too large".into());
    }
    let bytes = res.bytes().await.map_err(|e| e.to_string())?;
    if bytes.len() > MAX_BYTES {
        return Err("image too large".into());
    }

    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    let out = json!({ "data_url": format!("data:{mime};base64,{b64}"), "mime": mime });
    if let Ok(mut c) = CACHE.write() {
        if c.len() >= CACHE_CAP {
            c.clear();
        }
        c.insert(url, out.clone());
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_public_https_is_fetched() {
        assert!(refuse_reason("https://beta.playstructs.com/img/logo-snc.gif").is_none());
        assert!(refuse_reason("https://oh.energy/images/logo.svg").is_none());
        // Plain http would defeat the point of proxying at all.
        assert!(refuse_reason("http://oh.energy/images/logo.svg").is_some());
        assert!(refuse_reason("file:///etc/passwd").is_some());
        assert!(refuse_reason("data:image/png;base64,AAAA").is_some());
        assert!(refuse_reason("not a url").is_some());
    }

    /* A guild writes its own logo URL, so "fetch this for me" is an
     * instruction from another player. This app's OWN MCP server listens on
     * 127.0.0.1:8420 with a bearer token; a logo pointed at it would have us
     * make requests to ourselves on a stranger's say-so. */
    #[test]
    fn a_guild_cannot_point_us_at_ourselves() {
        for u in [
            "https://127.0.0.1:8420/mcp",
            "https://localhost:8420/mcp",
            "https://[::1]/x.png",
            "https://10.0.0.5/x.png",
            "https://192.168.1.1/x.png",
            "https://172.16.0.1/x.png",
            "https://169.254.169.254/latest/meta-data/",
            "https://0.0.0.0/x.png",
            "https://100.100.0.1/x.png",
        ] {
            assert!(refuse_reason(u).is_some(), "{u} must be refused");
        }
    }

    #[test]
    fn a_hostname_that_merely_looks_public_is_still_checked() {
        // Substring tests are what this codebase gets bitten by: `localhost`
        // as a suffix of another name must not pass on spelling alone, and a
        // name is judged by what it RESOLVES to.
        assert!(host_is_private("localhost"));
        assert!(host_is_private("api.localhost"));
        assert!(host_is_private("printer.local"));
        // A name that cannot resolve is not fetched.
        assert!(host_is_private("no-such-host.invalid"));
    }
}
