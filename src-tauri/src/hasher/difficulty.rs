/// Estimated block time in milliseconds.
///
/// The webapp's TASK.ESTIMATED_BLOCK_TIME is 5000, but the chain does NOT run
/// at 5.000 s. Measured against `structs.planet_activity` (3,500+ blocks/day
/// sampled over a week, 2026-07-30): **5.28 s**, steady at 5.277–5.341 daily.
/// Assuming 5.000 made the estimator run ~5.6% fast, so `estimate_age` drifted
/// AHEAD of the chain — computing a lower (easier) difficulty than the real
/// age justifies and producing proofs the chain rejects. Drift grew with task
/// runtime because the checkpoint is only taken once at task start; see
/// `refresh_checkpoint`, which now re-anchors mid-task so it can't accumulate.
pub const ESTIMATED_BLOCK_TIME_MS: f64 = 5280.0;

/// Difficulty (leading HEX zeros, 4 bits each) at which a task is admitted to
/// grind, unless the config or the tuner says otherwise.
///
/// Was 12 — 48 bits, 2.8e14 expected tries. No consumer GPU clears that
/// before the difficulty has decayed for another half hour, so an untuned
/// player's task ground uselessly from the moment it was admitted (a player's
/// 2026-09-04 log bundle: every build reaped as "stalled"). 8 is 32 bits:
/// ~4.3e9 tries, ~100 s at 40 MH/s, ~10 s at 400 MH/s, and it is where the
/// tuner's own floor sits (`tuner::DIFF_MIN`). The admission wait grows by a
/// few minutes of anchor age in exchange.
pub const DIFFICULTY_START: u64 = 8;

/// Sleep delay while waiting for difficulty to drop (matches TASK.DIFFICULTY_START_SLEEP_DELAY = 10000)
pub const DIFFICULTY_START_SLEEP_MS: u64 = 10000;

/// Iterations between progress checkpoints (matches TASK.CHECKPOINT_COMMIT = 5000000)
pub const CHECKPOINT_COMMIT: u64 = 5_000_000;

/// Is a progress checkpoint due after `total_hashes`, for an engine that
/// advances in whole batches of `batch_size`?
///
/// Every `max(1, CHECKPOINT_COMMIT / batch_size)` batches — the closest the
/// batch grain gets to the nominal cadence. Never test `total_hashes %
/// CHECKPOINT_COMMIT == 0` against batch totals: with a 2^20 batch the first
/// common multiple is 2^20 × 5^7 ≈ 8.2e10 hashes, so progress (and the
/// difficulty recalculation that rides on it) froze for 20–35 minutes and the
/// watchdog reaped healthy tasks as stalled.
pub fn gpu_checkpoint_due(total_hashes: u64, batch_size: u64) -> bool {
    let batch_size = batch_size.max(1);
    let per = (CHECKPOINT_COMMIT / batch_size).max(1);
    let batches = total_hashes / batch_size;
    batches > 0 && batches % per == 0
}

/// Iterations between difficulty recalculations (matches TASK.DIFFICULTY_RECALCULATE = 5000000)
pub const DIFFICULTY_RECALCULATE: u64 = 5_000_000;

/// Calculate difficulty based on block age and target.
///
/// Exact port of structsd v0.22.0 `types.CalculateDifficulty`
/// (x/structs/types/work.go): `64 - max{k ≤ 63 : range^k ≤ age^63}`.
///
/// v0.21 and earlier used `64 - floor(log10(age) / log10(range) * 63)`, and
/// so did this port. Float log10 differs in the last bit between platforms;
/// where the true ratio sits on an integer boundary that flips a whole hex
/// zero, so a proof we judged sufficient could be one the chain rejects. The
/// chain switched to integer arithmetic at the v0.22.0 upgrade (height
/// 3,353,000 on structstestnet-111), so this must match it exactly.
pub fn calculate_difficulty(age: u64, difficulty_target: u64) -> u64 {
    // log(1) = 0 and log(0) = -inf have no meaningful curve; the chain pins
    // both at the maximum rather than assuming a governed range.
    if age <= 1 || difficulty_target <= 1 {
        return 64;
    }
    let age_to_the_63 = (0..63).fold(vec![1u64], |n, _| mul_small(&n, age));
    let mut range_to_the_k = vec![1u64];
    let mut exponent = 0;
    for k in 1..=63 {
        range_to_the_k = mul_small(&range_to_the_k, difficulty_target);
        if cmp_limbs(&range_to_the_k, &age_to_the_63) == std::cmp::Ordering::Greater {
            break;
        }
        exponent = k;
    }
    64 - exponent
}

/// Little-endian u64 limbs × u64. age^63 for a u64 age is up to 4032 bits —
/// far past u128 — and this is the only big-number arithmetic the hasher needs.
fn mul_small(n: &[u64], m: u64) -> Vec<u64> {
    let mut out = Vec::with_capacity(n.len() + 1);
    let mut carry: u128 = 0;
    for &limb in n {
        let p = limb as u128 * m as u128 + carry;
        out.push(p as u64);
        carry = p >> 64;
    }
    if carry > 0 {
        out.push(carry as u64);
    }
    out
}

fn cmp_limbs(a: &[u64], b: &[u64]) -> std::cmp::Ordering {
    let trim = |x: &[u64]| x.iter().rposition(|&l| l != 0).map_or(0, |i| i + 1);
    let (la, lb) = (trim(a), trim(b));
    la.cmp(&lb).then_with(|| a[..la].iter().rev().cmp(b[..lb].iter().rev()))
}

/// Estimate the current block age (blocks since task started).
///
/// Port of TaskState.getCurrentAgeEstimate:
/// ```js
/// const estimated_blocks_past = Math.floor((current_time - block_checkpoint_time) / ESTIMATED_BLOCK_TIME);
/// block_current_estimated = Math.floor(block_checkpoint + estimated_blocks_past);
/// return block_current_estimated - block_start;
/// ```
pub fn estimate_age(
    block_start: u64,
    block_checkpoint: u64,
    checkpoint_time_ms: f64,
    now_ms: f64,
) -> (u64, u64) {
    let elapsed_ms = now_ms - checkpoint_time_ms;
    let estimated_blocks_past = (elapsed_ms / ESTIMATED_BLOCK_TIME_MS).floor() as u64;
    let block_current_estimated = block_checkpoint + estimated_blocks_past;
    let age = if block_current_estimated > block_start {
        block_current_estimated - block_start
    } else {
        0
    };
    (age, block_current_estimated)
}

/// Re-anchor a task's block checkpoint to live chain state.
///
/// Without this the checkpoint is captured once at task start and every later
/// age estimate is pure extrapolation, so any error in `ESTIMATED_BLOCK_TIME_MS`
/// compounds for the whole grind (hours, for REFINE). Re-anchoring at each
/// difficulty recalculation means the extrapolation only ever spans the time
/// since the last game-state sync (~10 s), so drift cannot accumulate.
///
/// `GAME_STATE.current_block_height` may itself lag the chain by a tick, which
/// biases the estimate slightly BEHIND — deliberately the safe direction: a
/// conservative age yields a HIGHER required difficulty, so the proof we find
/// is stronger than the chain demands and is still accepted. Overshooting is
/// what gets proofs rejected.
pub fn refresh_checkpoint(block_checkpoint: u64, checkpoint_time_ms: f64, now_ms: f64) -> (u64, f64) {
    let live = crate::game_state::GAME_STATE
        .read()
        .ok()
        .map(|g| g.current_block_height)
        .unwrap_or(0);
    if live > block_checkpoint {
        (live, now_ms)
    } else {
        (block_checkpoint, checkpoint_time_ms)
    }
}

/// Check if a SHA256 hash meets the required difficulty (leading hex zeros).
///
/// Port of TaskWorker.difficultyCheck, but operating on raw bytes instead of hex string.
/// N leading hex zeros = N/2 full zero bytes + possibly 1 zero nibble.
///
/// This is ~16x faster than converting to hex and checking characters.
pub fn check_difficulty(hash: &[u8; 32], required_zeros: u64) -> bool {
    let full_bytes = (required_zeros / 2) as usize;
    let remainder = required_zeros % 2;

    // Check full zero bytes
    for i in 0..full_bytes {
        if hash[i] != 0 {
            return false;
        }
    }

    // Check the remaining nibble (high 4 bits of the next byte)
    if remainder == 1 && full_bytes < 32 {
        if hash[full_bytes] >> 4 != 0 {
            return false;
        }
    }

    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_difficulty_age_1() {
        assert_eq!(calculate_difficulty(0, 100), 64);
        assert_eq!(calculate_difficulty(1, 100), 64);
    }

    #[test]
    fn test_difficulty_decreases() {
        // Use a high target so difficulty doesn't bottom out at 1
        let d1 = calculate_difficulty(10, 14000);
        let d2 = calculate_difficulty(100, 14000);
        let d3 = calculate_difficulty(1000, 14000);
        assert!(d1 > d2, "d1={} should be > d2={}", d1, d2);
        assert!(d2 > d3, "d2={} should be > d3={}", d2, d3);
    }

    #[test]
    fn test_difficulty_min_1() {
        // Very large age should still return at least 1
        assert!(calculate_difficulty(u64::MAX / 2, 100) >= 1);
    }

    #[test]
    fn integer_difficulty_matches_chain_boundaries() {
        // age == range: range^63 <= age^63 exactly, so k = 63 → 1.
        assert_eq!(calculate_difficulty(10, 10), 1);
        assert_eq!(calculate_difficulty(700, 700), 1);
        // Range <= 1 pins at the maximum, as on chain.
        assert_eq!(calculate_difficulty(500, 1), 64);
        assert_eq!(calculate_difficulty(500, 0), 64);
        // age = 2, range = 4: 4^k <= 2^63 ⟺ 2k <= 63 → k = 31 → 33.
        assert_eq!(calculate_difficulty(2, 4), 33);
        // age = 8, range = 4: 4^k <= 8^63 = 2^189 ⟺ k <= 94.5, capped at 63 → 1.
        assert_eq!(calculate_difficulty(8, 4), 1);
        // age = 2, range = 1024: 2^(10k) <= 2^63 → k = 6 → 58.
        assert_eq!(calculate_difficulty(2, 1024), 58);
        // Exact power boundary: 1000^21 = 10^63 = 10^63 → k = 21 → 43.
        assert_eq!(calculate_difficulty(10, 1000), 43);
        // One block short of the boundary loses that step: 9^63 < 1000^21.
        assert_eq!(calculate_difficulty(9, 1000), 44);
    }

    #[test]
    fn integer_difficulty_never_easier_than_old_float_curve_off_boundaries() {
        // Away from exact power boundaries the two curves agree; the integer
        // version only differs where float rounding crossed a whole step.
        for range in [10u64, 28_000, 14_000, 700, 213, 238] {
            for age in [2u64, 3, 7, 50, 333, 1_234, 9_999, 27_999] {
                let float = (64.0 - ((age as f64).log10() / (range as f64).log10() * 63.0).floor()).max(1.0) as u64;
                let int = calculate_difficulty(age, range);
                assert!(int.abs_diff(float) <= 1, "age={age} range={range} int={int} float={float}");
            }
        }
    }

    #[test]
    fn test_check_difficulty_0() {
        let hash = [0xff; 32];
        assert!(check_difficulty(&hash, 0));
    }

    #[test]
    fn test_check_difficulty_1() {
        // 1 leading hex zero = first nibble is 0, second can be anything
        let mut hash = [0xff; 32];
        hash[0] = 0x0f; // hex: "0f..." → 1 leading zero
        assert!(check_difficulty(&hash, 1));

        hash[0] = 0x1f; // hex: "1f..." → 0 leading zeros
        assert!(!check_difficulty(&hash, 1));
    }

    #[test]
    fn test_check_difficulty_2() {
        // 2 leading hex zeros = first byte is 0x00
        let mut hash = [0xff; 32];
        hash[0] = 0x00;
        assert!(check_difficulty(&hash, 2));

        hash[0] = 0x01;
        assert!(!check_difficulty(&hash, 2));
    }

    #[test]
    fn test_check_difficulty_3() {
        // 3 leading hex zeros = first byte 0x00, second byte high nibble 0
        let mut hash = [0xff; 32];
        hash[0] = 0x00;
        hash[1] = 0x0a; // hex: "000a..." → 3 leading zeros
        assert!(check_difficulty(&hash, 3));

        hash[1] = 0xa0; // hex: "00a0..." → 2 leading zeros
        assert!(!check_difficulty(&hash, 3));
    }

    #[test]
    fn test_estimate_age() {
        let (age, block_est) = estimate_age(100, 110, 0.0, 26_400.0);
        // 26400ms / 5280ms = exactly 5 blocks past the checkpoint
        assert_eq!(block_est, 115);
        assert_eq!(age, 15);
    }

    /// The estimator must never run AHEAD of the chain: an overshoot computes a
    /// difficulty easier than the real age justifies, and the chain rejects the
    /// resulting proof (the failure mode behind the 2026-07-30 solve treadmill).
    #[test]
    fn estimator_does_not_overshoot_real_chain_time() {
        const REAL_BLOCK_MS: f64 = 5280.0; // measured from planet_activity
        for minutes in [1.0_f64, 10.0, 60.0, 360.0] {
            let elapsed = minutes * 60_000.0;
            let (_, est) = estimate_age(0, 0, 0.0, elapsed);
            let real = (elapsed / REAL_BLOCK_MS).floor() as u64;
            assert!(
                est <= real,
                "after {minutes} min the estimate ({est}) must not exceed real blocks ({real})"
            );
        }
    }

    #[test]
    fn refresh_checkpoint_only_moves_forward() {
        let _head = crate::game_state::HEAD_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        // Live height unavailable in tests (GAME_STATE is 0) → keep the anchor.
        let (cp, cpt) = refresh_checkpoint(500, 1000.0, 9999.0);
        assert_eq!((cp, cpt), (500, 1000.0));
    }
}

#[cfg(test)]
mod checkpoint_tests {
    use super::*;

    const BATCH: u64 = 1 << 20;

    #[test]
    fn gpu_checkpoints_land_every_few_batches_not_every_eighty_billion_hashes() {
        // 5,000,000 / 2^20 = 4.77 → every 4 batches.
        let due: Vec<u64> = (1..=16).map(|b| b * BATCH).filter(|t| gpu_checkpoint_due(*t, BATCH)).collect();
        assert_eq!(due, vec![4 * BATCH, 8 * BATCH, 12 * BATCH, 16 * BATCH]);
        // The old test: no batch total satisfied it until the lcm, 5^7 batches
        // (2^20 × 5^7 ≈ 8.2e10 hashes) into the grind.
        assert!((1..78_125u64).all(|b| (b * BATCH) % CHECKPOINT_COMMIT != 0));
        assert_eq!((78_125u64 * BATCH) % CHECKPOINT_COMMIT, 0);
    }

    #[test]
    fn a_checkpoint_is_never_more_than_a_few_seconds_of_grinding_away() {
        // 4 batches at a slow 20 MH/s is ~0.2 s — nowhere near the 5-minute
        // stall horizon the watchdog uses.
        let per_batches = (CHECKPOINT_COMMIT / BATCH).max(1);
        let hashes = per_batches * BATCH;
        assert!(hashes as f64 / 20_000_000.0 < 1.0, "{hashes} hashes between checkpoints");
    }

    #[test]
    fn checkpoint_helper_handles_odd_batch_sizes_and_zero() {
        assert!(!gpu_checkpoint_due(0, BATCH));
        // A batch larger than the nominal cadence checkpoints every batch.
        assert!(gpu_checkpoint_due(10_000_000, 10_000_000));
        assert!(gpu_checkpoint_due(20_000_000, 10_000_000));
        // A degenerate batch size of 0 must not divide by zero.
        assert!(gpu_checkpoint_due(CHECKPOINT_COMMIT, 0));
    }

    #[test]
    fn default_admission_difficulty_is_something_a_gpu_can_clear() {
        // Expected tries at the default start: 16^d. 40 MH/s must clear it in
        // a few minutes, or an untuned player's task grinds forever.
        let tries = 16f64.powi(DIFFICULTY_START as i32);
        assert!(tries / 40_000_000.0 < 5.0 * 60.0, "{tries} tries at difficulty {DIFFICULTY_START}");
    }

    /// The invariant the whole raid-retune feature rests on, and nothing pinned
    /// it before: `difficulty_target` is a decay RANGE, so a BIGGER range is a
    /// HARDER proof at any given age. A raid's range is the target planet's
    /// live `planetaryShield` — which is why a defender who builds a shield
    /// struct mid-raid invalidates the attacker's in-flight proof, and why
    /// killing one shortens it.
    #[test]
    fn a_bigger_range_is_a_harder_proof() {
        // 238 and 213 are a real observation: one Orbital Shield Generator
        // (contribution 25) destroyed mid-raid, 2026-08-07.
        for age in [2u64, 10, 50, 125, 238, 1_000, 10_000, 100_000] {
            assert!(
                calculate_difficulty(age, 238) >= calculate_difficulty(age, 213),
                "age {age}: a bigger shield must never be the easier proof"
            );
        }
        // And strictly harder somewhere in the range that matters.
        assert!(calculate_difficulty(100, 238) > calculate_difficulty(100, 213));
        // Below age 2 the curve is pinned regardless of range: you cannot
        // complete on the block you initiated.
        for range in [2u64, 213, 238, 28_000] {
            assert_eq!(calculate_difficulty(0, range), 64);
            assert_eq!(calculate_difficulty(1, range), 64);
        }
    }
}
