//! Name resolution that remembers the last answer that worked.
//!
//! 2026-09-29, 03:52 UTC: for two minutes `matrix.crew.oh.energy` did not
//! resolve on one machine. The homeserver was very probably fine — the record
//! has a five-minute TTL, one refresh failed, and the operating system cached
//! the failure — but to the client it was indistinguishable from an outage:
//! every send, lookup and media fetch failed until the cache cleared.
//!
//! A homeserver does not move between one minute and the next. So when a name
//! that resolved earlier stops resolving, the address it had is still the best
//! answer there is, and TLS makes using it safe: the certificate is checked
//! against the NAME, so a stale address that is no longer the server simply
//! fails the handshake. Nothing here can be talked into trusting a wrong host.
//!
//! Only a fallback. A fresh answer always wins and replaces what was kept, and
//! a name that has never resolved in this run still fails as it did before.

use reqwest::dns::{Addrs, Name, Resolve, Resolving};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, LazyLock, Mutex};

/// How long a remembered address may stand in for a name that will not
/// resolve. A day: long enough for any resolver hiccup, short enough that a
/// server which really did move is not chased for ever.
const STALE_FOR_SECS: u64 = 24 * 60 * 60;

type Kept = (Vec<SocketAddr>, u64);

static LAST_GOOD: LazyLock<Mutex<HashMap<String, Kept>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

pub struct Sticky;

/// The resolver every Comms HTTP client is built with.
pub fn resolver() -> Arc<Sticky> {
    Arc::new(Sticky)
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// What to answer with: the fresh addresses when there are any, else the
/// remembered ones while they are young enough, else the failure. The flag
/// says whether the answer is a remembered one.
pub fn choose(
    fresh: Result<Vec<SocketAddr>, String>,
    kept: Option<&Kept>,
    now: u64,
) -> (Result<Vec<SocketAddr>, String>, bool) {
    let why = match fresh {
        Ok(addrs) if !addrs.is_empty() => return (Ok(addrs), false),
        Ok(_) => "the name resolved to no address".to_string(),
        Err(e) => e,
    };
    match kept {
        Some((addrs, at)) if !addrs.is_empty() && now.saturating_sub(*at) <= STALE_FOR_SECS => {
            (Ok(addrs.clone()), true)
        }
        _ => (Err(why), false),
    }
}

impl Resolve for Sticky {
    fn resolve(&self, name: Name) -> Resolving {
        let host = name.as_str().to_string();
        Box::pin(async move {
            let fresh = tokio::net::lookup_host((host.as_str(), 0))
                .await
                .map(|a| a.collect::<Vec<_>>())
                .map_err(|e| e.to_string());
            let now = now_secs();
            let kept = LAST_GOOD.lock().ok().and_then(|m| m.get(&host).cloned());
            let (answer, remembered) = choose(fresh, kept.as_ref(), now);
            match answer {
                Ok(addrs) => {
                    if remembered {
                        eprintln!(
                            "[Comms] {host} did not resolve; using the address it last had"
                        );
                    } else if let Ok(mut m) = LAST_GOOD.lock() {
                        m.insert(host, (addrs.clone(), now));
                    }
                    Ok(Box::new(addrs.into_iter()) as Addrs)
                }
                Err(e) => Err(Box::<dyn std::error::Error + Send + Sync>::from(e)),
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn addr(s: &str) -> SocketAddr {
        s.parse().unwrap()
    }

    #[test]
    fn a_fresh_answer_always_wins() {
        let kept = (vec![addr("10.0.0.1:0")], 100);
        let (out, remembered) = choose(Ok(vec![addr("10.0.0.2:0")]), Some(&kept), 200);
        assert_eq!(out.unwrap(), vec![addr("10.0.0.2:0")]);
        assert!(!remembered);
    }

    #[test]
    fn a_name_that_stops_resolving_keeps_the_address_it_had() {
        let kept = (vec![addr("155.138.156.195:0")], 1_000);
        let (out, remembered) = choose(
            Err("nodename nor servname provided, or not known".into()),
            Some(&kept),
            1_120,
        );
        assert_eq!(out.unwrap(), vec![addr("155.138.156.195:0")]);
        assert!(remembered, "and says that it is a remembered answer");
        // An empty answer is a failure too, not an address.
        let (out, remembered) = choose(Ok(vec![]), Some(&kept), 1_120);
        assert!(out.is_ok() && remembered);
    }

    #[test]
    fn a_remembered_address_does_not_stand_in_for_ever() {
        let kept = (vec![addr("155.138.156.195:0")], 1_000);
        let (out, remembered) = choose(Err("no".into()), Some(&kept), 1_000 + STALE_FOR_SECS + 1);
        assert!(out.is_err());
        assert!(!remembered);
    }

    #[test]
    fn a_name_that_never_resolved_fails_as_it_always_did() {
        let (out, remembered) = choose(Err("not known".into()), None, 5);
        assert_eq!(out.unwrap_err(), "not known");
        assert!(!remembered);
    }
}
