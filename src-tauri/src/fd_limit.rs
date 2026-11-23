//! The open-file limit.
//!
//! macOS starts GUI apps with a soft limit of 256 open files (`launchctl limit
//! maxfiles`), and every socket counts. Past it, DNS lookups, HTTP requests and
//! plain file reads all fail at once. The hard limit is far higher, and a
//! process may raise its own soft limit up to it.

/// Plenty for every socket and file this app opens, and under macOS's
/// OPEN_MAX (10,240), which `setrlimit` refuses to pass on some versions.
#[cfg(unix)]
const WANTED: u64 = 8192;

/// The soft limit to ask for, or `None` when the current one will do.
#[cfg(unix)]
fn target(soft: u64, hard: u64) -> Option<u64> {
    let want = WANTED.min(hard);
    (want > soft).then_some(want)
}

/// Raise the soft limit. `Ok((before, after))`; never lowers it.
#[cfg(unix)]
fn raise() -> std::io::Result<(u64, u64)> {
    let mut lim = libc::rlimit { rlim_cur: 0, rlim_max: 0 };
    // SAFETY: `lim` is a valid rlimit for the call to fill in.
    if unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut lim) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    let before = lim.rlim_cur as u64;
    let Some(want) = target(before, lim.rlim_max as u64) else {
        return Ok((before, before));
    };
    lim.rlim_cur = want as libc::rlim_t;
    // SAFETY: `lim` is initialised, with the hard limit left as it was.
    if unsafe { libc::setrlimit(libc::RLIMIT_NOFILE, &lim) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok((before, want))
}

/// Called first thing in `main`, before anything opens a socket.
pub fn raise_at_startup() {
    #[cfg(unix)]
    {
        use crate::mcp::telemetry::{tlog, Sev};
        match raise() {
            Ok((before, after)) => tlog("fd_limit", Sev::Info, format!("open-file limit {before} → {after}")),
            Err(e) => tlog("fd_limit", Sev::Warn, format!("could not raise the open-file limit: {e}")),
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn asks_for_enough_but_never_past_the_hard_limit_and_never_lowers() {
        assert_eq!(target(256, u64::MAX), Some(WANTED));
        assert_eq!(target(256, 4096), Some(4096));
        assert_eq!(target(WANTED, u64::MAX), None);
        assert_eq!(target(1_048_576, u64::MAX), None);
        assert_eq!(target(256, 256), None);
    }

    /// The real call. Run it under a GUI app's limit to see it work:
    ///   ulimit -S -n 256 && <test binary> fd_limit --nocapture
    #[test]
    fn the_process_ends_up_with_the_limit_it_reports() {
        let (before, after) = raise().unwrap();
        println!("open-file limit {before} → {after}");
        assert!(after >= before);
        let mut lim = libc::rlimit { rlim_cur: 0, rlim_max: 0 };
        assert_eq!(unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut lim) }, 0);
        assert_eq!(lim.rlim_cur as u64, after);
        if after >= 2048 {
            // The limit is real, not just reported: hold more than 256 open.
            let open: Vec<_> = (0..600).map(|_| std::fs::File::open("/dev/null").unwrap()).collect();
            assert_eq!(open.len(), 600);
        }
    }
}
