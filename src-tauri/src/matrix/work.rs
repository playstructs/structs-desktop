//! Sharing proof-of-work over chat.
//!
//! A task's grinding input is entirely public — object id, task type, and the
//! cycle anchor. No key, no signature. Anyone who knows those can grind the
//! same task as its owner.
//!
//! Submission is the part that needs permission: the completion message
//! carries `{structId|fleetId, proof, nonce}` and the signer injects
//! `creator`, so only the owner can send it. That asymmetry is the whole
//! feature — computation is free to share, authority is not.
//!
//! See `proposals/shared-proof-of-work.md` for the review this came from.

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

/// The four kinds of work the chain issues a proof puzzle for.
pub const KINDS: [&str; 4] = ["MINE", "REFINE", "BUILD", "RAID"];

/// Rebuild the grinding prefix exactly as the local hasher does.
///
/// The literal `NONCE` is part of it: the message ground is
/// `prefix + nonce_as_decimal + postfix`, and postfix is empty, so the word
/// is what separates the anchor from the number. Getting this wrong produces
/// a proof that is valid against nothing.
pub fn prefix(object_id: &str, task: &str, block_start: u64, target_id: Option<&str>) -> String {
    match (task, target_id) {
        ("RAID", Some(target)) => format!("{}@{}{}{}NONCE", object_id, target, task, block_start),
        _ => format!("{}{}{}NONCE", object_id, task, block_start),
    }
}

/// Check a nonce somebody else found.
///
/// Rebuilt from fields THIS side supplies, never from the message: a result
/// arriving over federation is a claim, and the only part of it worth
/// trusting is the number. Everything else is reconstructed here and the
/// hash recomputed.
pub fn verify(
    object_id: &str,
    task: &str,
    block_start: u64,
    target_id: Option<&str>,
    nonce: &str,
    difficulty: u64,
) -> Option<String> {
    // A nonce is a decimal integer. Anything else is not a nonce, and
    // concatenating it would hash something the chain will never reproduce.
    if nonce.is_empty() || !nonce.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let message = format!("{}{}", prefix(object_id, task, block_start, target_id), nonce);
    let hash: [u8; 32] = Sha256::digest(message.as_bytes()).into();
    if crate::hasher::difficulty::check_difficulty(&hash, difficulty) {
        Some(hex::encode(hash))
    } else {
        None
    }
}

/// Read a `structs.work` block out of a message, if it carries one and it is
/// well formed.
///
/// Strict on purpose. This is other people's JSON arriving over federation,
/// and a half-parsed offer renders as a card inviting somebody to spend an
/// hour of GPU on nonsense.
pub fn parse(content: &Value) -> Option<Value> {
    let w = content.get("structs.work")?;
    if w.get("v").and_then(|v| v.as_u64()) != Some(1) {
        return None;
    }
    let kind = w.get("kind").and_then(|k| k.as_str())?;
    let task = w.get("task").and_then(|t| t.as_str())?;
    if !KINDS.contains(&task) {
        return None;
    }
    let object = w.get("object").and_then(|o| o.as_str())?;
    if super::refs::parse_id(object).is_none() {
        return None;
    }
    let block_start = w.get("block_start").and_then(|b| b.as_u64())?;
    if block_start == 0 {
        return None; // no cycle running; nothing to prove
    }
    // RAID grinds against a target, and its prefix is a different shape. An
    // offer without one would have every solver computing the wrong string.
    let target = w.get("target").and_then(|t| t.as_str()).filter(|t| !t.is_empty());
    if task == "RAID" && target.is_none() {
        return None;
    }
    if let Some(t) = target {
        if super::refs::parse_id(t).is_none() {
            return None;
        }
    }

    let mut out = json!({
        "kind": kind, "task": task, "object": object,
        "block_start": block_start, "target": target,
        "difficulty": w.get("difficulty").and_then(|d| d.as_u64()).unwrap_or(0),
    });
    match kind {
        "offer" => {}
        "result" => {
            let nonce = w.get("nonce").and_then(|n| n.as_str())?;
            if nonce.is_empty() || !nonce.bytes().all(|b| b.is_ascii_digit()) {
                return None;
            }
            out["nonce"] = json!(nonce);
        }
        _ => return None,
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_prefix_matches_what_the_local_hasher_grinds() {
        // Straight from mcp/tools/hasher.rs. If these ever diverge, every
        // shared proof is valid against nothing — and it would look like the
        // chain rejecting good work rather than like a formatting bug.
        assert_eq!(prefix("5-2184", "MINE", 812004, None), "5-2184MINE812004NONCE");
        assert_eq!(
            prefix("9-77", "RAID", 812004, Some("2-15361")),
            "9-77@2-15361RAID812004NONCE"
        );
        // A target on a non-raid task is not part of its prefix.
        assert_eq!(prefix("5-1", "BUILD", 7, Some("2-1")), "5-1BUILD7NONCE");
    }

    #[test]
    fn a_verified_nonce_reproduces_the_hash() {
        // Difficulty 0 accepts anything, which is what lets this assert the
        // ARITHMETIC without grinding for real zeros in a unit test.
        let got = verify("5-2184", "MINE", 812004, None, "12345", 0).unwrap();
        let expect = hex::encode(Sha256::digest(b"5-2184MINE812004NONCE12345"));
        assert_eq!(got, expect);
    }

    #[test]
    fn a_nonce_that_does_not_meet_the_difficulty_is_refused() {
        // 32 leading zero-nibbles is unreachable for this input.
        assert!(verify("5-2184", "MINE", 812004, None, "12345", 60).is_none());
    }

    #[test]
    fn only_a_decimal_nonce_is_a_nonce() {
        // Concatenating anything else hashes a string the chain will never
        // reproduce — so it would "verify" here and fail on submission.
        for bad in ["", "12a45", "0x1f", "-5", " 12", "12 ", "1.5"] {
            assert!(verify("5-2184", "MINE", 812004, None, bad, 0).is_none(), "{}", bad);
        }
        assert!(verify("5-2184", "MINE", 812004, None, "0", 0).is_some());
    }

    fn offer(extra: Value) -> Value {
        let mut w = json!({
            "v": 1, "kind": "offer", "task": "MINE",
            "object": "5-2184", "block_start": 812004, "difficulty": 5
        });
        if let (Some(w), Some(extra)) = (w.as_object_mut(), extra.as_object()) {
            for (k, v) in extra {
                w.insert(k.clone(), v.clone());
            }
        }
        json!({ "body": "work wanted", "structs.work": w })
    }

    #[test]
    fn a_well_formed_offer_parses() {
        let got = parse(&offer(json!({}))).unwrap();
        assert_eq!(got["task"], "MINE");
        assert_eq!(got["object"], "5-2184");
        assert_eq!(got["block_start"], 812004);
    }

    #[test]
    fn malformed_work_is_not_a_card() {
        // Other people's JSON over federation. A half-parsed offer renders as
        // a card inviting somebody to spend an hour of GPU on nonsense.
        assert!(parse(&json!({ "body": "hi" })).is_none(), "no work block");
        assert!(parse(&offer(json!({ "v": 2 }))).is_none(), "unknown version");
        assert!(parse(&offer(json!({ "task": "SUDO" }))).is_none(), "unknown task");
        assert!(parse(&offer(json!({ "object": "nonsense" }))).is_none(), "bad id");
        assert!(parse(&offer(json!({ "block_start": 0 }))).is_none(), "no cycle");
        assert!(parse(&offer(json!({ "kind": "whatever" }))).is_none(), "unknown kind");
        // A raid without a target would have every solver grinding the wrong
        // string and blaming the chain for refusing it.
        assert!(parse(&offer(json!({ "task": "RAID" }))).is_none(), "raid needs a target");
        assert!(
            parse(&offer(json!({ "task": "RAID", "target": "2-15361" }))).is_some(),
            "raid with a target is fine"
        );
    }

    #[test]
    fn a_result_must_carry_a_usable_nonce() {
        let result = |nonce: Value| {
            offer(json!({ "kind": "result", "nonce": nonce }))
        };
        assert_eq!(parse(&result(json!("918273645"))).unwrap()["nonce"], "918273645");
        assert!(parse(&result(json!(""))).is_none());
        assert!(parse(&result(json!("cafe"))).is_none());
        // A number rather than a string: nonces exceed 2^53 and JSON would
        // round them. The string form is the only one that survives.
        assert!(parse(&result(json!(918273645u64))).is_none());
        assert!(parse(&offer(json!({ "kind": "result" }))).is_none(), "no nonce at all");
    }
}
