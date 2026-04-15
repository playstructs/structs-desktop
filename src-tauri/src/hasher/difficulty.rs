/// Estimated block time in milliseconds (matches TASK.ESTIMATED_BLOCK_TIME = 5000)
pub const ESTIMATED_BLOCK_TIME_MS: f64 = 5000.0;

/// Minimum difficulty before hashing starts (higher than JS default of 10
/// because Rust hasher is orders of magnitude faster)
pub const DIFFICULTY_START: u64 = 12;

/// Sleep delay while waiting for difficulty to drop (matches TASK.DIFFICULTY_START_SLEEP_DELAY = 10000)
pub const DIFFICULTY_START_SLEEP_MS: u64 = 10000;

/// Iterations between progress checkpoints (matches TASK.CHECKPOINT_COMMIT = 5000000)
pub const CHECKPOINT_COMMIT: u64 = 5_000_000;

/// Iterations between difficulty recalculations (matches TASK.DIFFICULTY_RECALCULATE = 5000000)
pub const DIFFICULTY_RECALCULATE: u64 = 5_000_000;

/// Calculate difficulty based on block age and target.
///
/// Port of TaskState.getCalculatedDifficulty / getCurrentDifficulty:
/// ```js
/// if (age <= 1) return 64;
/// let difficulty = 64 - Math.floor(Math.log10(age) / Math.log10(difficulty_target) * 63);
/// return Math.max(1, difficulty);
/// ```
pub fn calculate_difficulty(age: u64, difficulty_target: u64) -> u64 {
    if age <= 1 {
        return 64;
    }
    let age_f = age as f64;
    let target_f = difficulty_target as f64;
    let difficulty = 64.0 - (age_f.log10() / target_f.log10() * 63.0).floor();
    (difficulty as i64).max(1) as u64
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
        let d1 = calculate_difficulty(10, 100);
        let d2 = calculate_difficulty(100, 100);
        let d3 = calculate_difficulty(1000, 100);
        assert!(d1 > d2);
        assert!(d2 > d3);
    }

    #[test]
    fn test_difficulty_min_1() {
        // Very large age should still return at least 1
        assert!(calculate_difficulty(u64::MAX / 2, 100) >= 1);
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
        let (age, block_est) = estimate_age(100, 110, 0.0, 25000.0);
        // 25000ms / 5000ms = 5 blocks past checkpoint
        assert_eq!(block_est, 115);
        assert_eq!(age, 15);
    }
}
