//! Deterministic, role-themed profile pictures for team players.
//!
//! A player's on-chain `pfpClientRenderAttributes` is a 5-layer portrait
//! (background, arms, body, neck, head — painted back to front). We split the
//! layers into a ROLE signal and an IDENTITY signal so the Team Ops roster is
//! both self-explanatory and individually legible:
//!
//!   * `background` + `body` → FIXED per role — the squad's frame color and
//!     torso silhouette, readable at a glance.
//!   * `head` + `neck` + `arms` → derived from the HD index — a unique face per
//!     player so no two look alike.
//!
//! Role frames (indices chosen from the art in `frontend/img/pfp/`):
//!   * primary    → starfield background (bg 1) + gold pauldron body (body 48)
//!   * productive → blue background       (bg 6) + blue-trim body   (body 25)
//!   * bait       → red background        (bg 2) + light suit body   (body 10)
//!
//! This is the single source of truth for BOTH the creation hook (set a look at
//! signup) and the backfill (`structs_players pfp`). The board renders whatever
//! is actually on-chain, so this only decides what we WRITE.

/// Part inventory sizes — must match `frontend/img/pfp/<part>/` file counts and
/// the webapp's `PFP_PART_COUNTS`. head/neck/arms vary per player; body and
/// background are pinned per role below so their counts are not needed here.
const HEAD: u32 = 87;
const NECK: u32 = 10;
const ARMS: u32 = 34;

/// FNV-1a (32-bit) over the ASCII bytes of `key`. Small, dependency-free, and
/// stable across builds/platforms so a player's face never changes.
fn fnv1a(key: &str) -> u32 {
    let mut h: u32 = 2_166_136_261;
    for b in key.bytes() {
        h ^= b as u32;
        h = h.wrapping_mul(16_777_619);
    }
    h
}

/// 1-based part index for `part`, deterministic in the HD `index`.
fn part_for(index: u32, part: &str, count: u32) -> u32 {
    (fnv1a(&format!("{}:{}", index, part)) % count) + 1
}

/// `(background, body)` that identify a role at a glance. Unknown roles fall to
/// the bait frame (the safe default for a mine-only decoy).
fn role_frame(role: &str) -> (u32, u32) {
    match role {
        "primary" => (1, 48),
        "productive" => (6, 25),
        _ => (2, 10),
    }
}

/// The on-chain `pfpClientRenderAttributes` JSON string for a team player.
/// `index` is the HD index (use 0 for the primary). Key order + spacing match
/// the value the chain stores so a re-computed attrs string compares equal to
/// the stored one (idempotent backfill).
pub fn role_pfp_attrs(role: &str, index: u32) -> String {
    let (background, body) = role_frame(role);
    format!(
        "{{\"head\":{},\"neck\":{},\"body\":{},\"arms\":{},\"background\":{}}}",
        part_for(index, "head", HEAD),
        part_for(index, "neck", NECK),
        body,
        part_for(index, "arms", ARMS),
        background,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn worker17_matches_the_value_written_on_chain() {
        // Locked against the live write in this feature's bring-up: worker17 is
        // HD index 17, productive. If this changes, every backfilled face moves.
        assert_eq!(
            role_pfp_attrs("productive", 17),
            r#"{"head":69,"neck":1,"body":25,"arms":23,"background":6}"#
        );
    }

    #[test]
    fn role_frames_are_distinct() {
        // background + body differ across the three roles → squads read apart.
        let frame = |r: &str| {
            let s = role_pfp_attrs(r, 5);
            let bg = s.split("\"background\":").nth(1).unwrap().trim_end_matches('}').to_string();
            let body = s.split("\"body\":").nth(1).unwrap().split(',').next().unwrap().to_string();
            (bg, body)
        };
        let (pb, pd) = (frame("primary"), frame("productive"));
        let bt = frame("bait");
        assert_ne!(pb, pd);
        assert_ne!(pd, bt);
        assert_ne!(pb, bt);
    }

    #[test]
    fn heads_vary_by_index_but_body_background_are_pinned() {
        let a = role_pfp_attrs("bait", 1);
        let b = role_pfp_attrs("bait", 2);
        assert_ne!(a, b); // different faces
        assert!(a.contains("\"body\":10") && a.contains("\"background\":2"));
        assert!(b.contains("\"body\":10") && b.contains("\"background\":2"));
    }

    #[test]
    fn parts_stay_in_range() {
        for idx in 0..500u32 {
            for role in ["primary", "productive", "bait"] {
                let s = role_pfp_attrs(role, idx);
                let get = |k: &str, max: u32| {
                    let v: u32 = s.split(&format!("\"{}\":", k)).nth(1).unwrap()
                        .split(|c| c == ',' || c == '}').next().unwrap().parse().unwrap();
                    assert!(v >= 1 && v <= max, "{}={} out of 1..={}", k, v, max);
                };
                get("head", HEAD);
                get("neck", NECK);
                get("arms", ARMS);
            }
        }
    }
}
