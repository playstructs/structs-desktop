// SHA256 compute shader for proof-of-work hashing.
// Each thread tests one nonce: hash(prefix + nonce_as_decimal_string + postfix)
// and checks for the required number of leading hex zeros.

// ── Uniforms & Buffers ──

struct Params {
    base_nonce: u32,       // Low 32 bits of base nonce
    base_nonce_high: u32,  // High 32 bits of base nonce
    required_zeros: u32,   // Number of leading hex zeros
    prefix_len: u32,       // Length of prefix in bytes
    postfix_len: u32,      // Length of postfix in bytes
    batch_size: u32,       // Total threads in this dispatch
    _pad0: u32,
    _pad1: u32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> prefix_data: array<u32>;   // Prefix bytes packed as u32
@group(0) @binding(2) var<storage, read> postfix_data: array<u32>;  // Postfix bytes packed as u32
@group(0) @binding(3) var<storage, read_write> result: array<atomic<u32>>; // [found_flag, nonce_low, nonce_high, hash[0..7]]

// ── SHA256 Constants ──

const K: array<u32, 64> = array<u32, 64>(
    0x428a2f98u, 0x71374491u, 0xb5c0fbcfu, 0xe9b5dba5u, 0x3956c25bu, 0x59f111f1u, 0x923f82a4u, 0xab1c5ed5u,
    0xd807aa98u, 0x12835b01u, 0x243185beu, 0x550c7dc3u, 0x72be5d74u, 0x80deb1feu, 0x9bdc06a7u, 0xc19bf174u,
    0xe49b69c1u, 0xefbe4786u, 0x0fc19dc6u, 0x240ca1ccu, 0x2de92c6fu, 0x4a7484aau, 0x5cb0a9dcu, 0x76f988dau,
    0x983e5152u, 0xa831c66du, 0xb00327c8u, 0xbf597fc7u, 0xc6e00bf3u, 0xd5a79147u, 0x06ca6351u, 0x14292967u,
    0x27b70a85u, 0x2e1b2138u, 0x4d2c6dfcu, 0x53380d13u, 0x650a7354u, 0x766a0abbu, 0x81c2c92eu, 0x92722c85u,
    0xa2bfe8a1u, 0xa81a664bu, 0xc24b8b70u, 0xc76c51a3u, 0xd192e819u, 0xd6990624u, 0xf40e3585u, 0x106aa070u,
    0x19a4c116u, 0x1e376c08u, 0x2748774cu, 0x34b0bcb5u, 0x391c0cb3u, 0x4ed8aa4au, 0x5b9cca4fu, 0x682e6ff3u,
    0x748f82eeu, 0x78a5636fu, 0x84c87814u, 0x8cc70208u, 0x90befffau, 0xa4506cebu, 0xbef9a3f7u, 0xc67178f2u
);

const H_INIT: array<u32, 8> = array<u32, 8>(
    0x6a09e667u, 0xbb67ae85u, 0x3c6ef372u, 0xa54ff53au,
    0x510e527fu, 0x9b05688cu, 0x1f83d9abu, 0x5be0cd19u
);

// ── SHA256 Helper Functions ──

fn rotr(x: u32, n: u32) -> u32 {
    return (x >> n) | (x << (32u - n));
}

fn ch(x: u32, y: u32, z: u32) -> u32 {
    return (x & y) ^ (~x & z);
}

fn maj(x: u32, y: u32, z: u32) -> u32 {
    return (x & y) ^ (x & z) ^ (y & z);
}

fn sigma0(x: u32) -> u32 {
    return rotr(x, 2u) ^ rotr(x, 13u) ^ rotr(x, 22u);
}

fn sigma1(x: u32) -> u32 {
    return rotr(x, 6u) ^ rotr(x, 11u) ^ rotr(x, 25u);
}

fn gamma0(x: u32) -> u32 {
    return rotr(x, 7u) ^ rotr(x, 18u) ^ (x >> 3u);
}

fn gamma1(x: u32) -> u32 {
    return rotr(x, 17u) ^ rotr(x, 19u) ^ (x >> 10u);
}

// ── Message Buffer ──
// Max message: 128 bytes prefix + 20 bytes nonce + 128 bytes postfix = 276 bytes
// Padded to 512 bits (64 bytes) blocks. We support up to 2 blocks (128 bytes).
// For our use case, messages are typically < 64 bytes so 2 blocks is plenty.

var<private> msg: array<u32, 32>; // 128 bytes as u32s
var<private> msg_len: u32;

fn set_msg_byte(pos: u32, val: u32) {
    let word_idx = pos / 4u;
    let byte_idx = 3u - (pos % 4u); // Big-endian byte order within u32
    let shift = byte_idx * 8u;
    let mask = ~(0xFFu << shift);
    msg[word_idx] = (msg[word_idx] & mask) | ((val & 0xFFu) << shift);
}

fn get_prefix_byte(byte_pos: u32) -> u32 {
    let word_idx = byte_pos / 4u;
    let byte_idx = byte_pos % 4u;
    let shift = (3u - byte_idx) * 8u;
    return (prefix_data[word_idx] >> shift) & 0xFFu;
}

fn get_postfix_byte(byte_pos: u32) -> u32 {
    let word_idx = byte_pos / 4u;
    let byte_idx = byte_pos % 4u;
    let shift = (3u - byte_idx) * 8u;
    return (postfix_data[word_idx] >> shift) & 0xFFu;
}

// ── Integer to Decimal String ──
// Converts a u64 (as two u32s) to its decimal string representation.
// Returns the number of digits written.

fn u64_to_decimal(low: u32, high: u32, start_pos: u32) -> u32 {
    var digits: array<u32, 20>; // Max 20 digits for u64
    var num_digits: u32 = 0u;

    // Work with the number as (high, low)
    var h: u32 = high;
    var l: u32 = low;

    // Handle zero
    if (h == 0u && l == 0u) {
        set_msg_byte(start_pos, 48u); // '0'
        return 1u;
    }

    // Extract digits by repeated division by 10
    // For u64 division: use double-word division
    while (h > 0u || l > 0u) {
        // Divide (h:l) by 10, get remainder
        var rem: u32 = 0u;

        // Divide high part
        let new_h = h / 10u;
        rem = h - new_h * 10u;
        h = new_h;

        // Combine remainder with low part and divide
        // rem * 2^32 + l divided by 10
        let combined_high = rem;
        // Split into manageable parts to avoid overflow
        let rh = combined_high * 429496729u; // floor(2^32 / 10) * rem
        let rh_rem = combined_high * 6u + (combined_high * 429496729u - rh * 10u); // approximate
        // More precise: (rem * 2^32 + l) / 10
        let full_low = l;
        let carry = combined_high; // rem from high division

        // Simple approach: use the fact that rem < 10
        // (rem * 4294967296 + l) / 10
        // = rem * 429496729 + (rem * 6 + l) / 10
        let base_q = carry * 429496729u;
        let base_r = carry * 6u + full_low;
        let extra_q = base_r / 10u;
        let extra_r = base_r - extra_q * 10u;

        l = base_q + extra_q;
        // Swap: the new (h, l) is (h, base_q + extra_q)
        // Actually h is already divided above, l is the new quotient

        digits[num_digits] = extra_r;
        num_digits = num_digits + 1u;
    }

    // Write digits in reverse order (most significant first)
    for (var i: u32 = 0u; i < num_digits; i = i + 1u) {
        let digit = digits[num_digits - 1u - i];
        set_msg_byte(start_pos + i, 48u + digit); // '0' + digit
    }

    return num_digits;
}

// ── SHA256 Hash ──

fn sha256_hash() -> array<u32, 8> {
    // Pad the message
    let bit_len: u32 = msg_len * 8u;
    let padded_len = msg_len + 1u; // +1 for 0x80 byte

    // Set 0x80 byte after message
    set_msg_byte(msg_len, 0x80u);

    // Zero fill up to length field
    // Determine number of blocks needed
    var total_len: u32;
    if (padded_len + 8u <= 64u) {
        total_len = 64u;
    } else {
        total_len = 128u;
    }

    // Zero bytes between 0x80 and length
    for (var i: u32 = padded_len; i < total_len - 8u; i = i + 1u) {
        set_msg_byte(i, 0u);
    }

    // Append length as 64-bit big-endian (we only use 32-bit length)
    let len_word_start = (total_len - 8u) / 4u;
    msg[len_word_start] = 0u;     // High 32 bits of bit length
    msg[len_word_start + 1u] = bit_len; // Low 32 bits of bit length

    var h: array<u32, 8> = H_INIT;

    let num_blocks = total_len / 64u;

    for (var block: u32 = 0u; block < num_blocks; block = block + 1u) {
        var w: array<u32, 64>;
        let base = block * 16u;

        // Load message block
        for (var i: u32 = 0u; i < 16u; i = i + 1u) {
            w[i] = msg[base + i];
        }

        // Extend
        for (var i: u32 = 16u; i < 64u; i = i + 1u) {
            w[i] = gamma1(w[i - 2u]) + w[i - 7u] + gamma0(w[i - 15u]) + w[i - 16u];
        }

        // Compress
        var a = h[0]; var b = h[1]; var c = h[2]; var d = h[3];
        var e = h[4]; var f = h[5]; var g = h[6]; var hh = h[7];

        for (var i: u32 = 0u; i < 64u; i = i + 1u) {
            let t1 = hh + sigma1(e) + ch(e, f, g) + K[i] + w[i];
            let t2 = sigma0(a) + maj(a, b, c);
            hh = g; g = f; f = e; e = d + t1;
            d = c; c = b; b = a; a = t1 + t2;
        }

        h[0] = h[0] + a; h[1] = h[1] + b; h[2] = h[2] + c; h[3] = h[3] + d;
        h[4] = h[4] + e; h[5] = h[5] + f; h[6] = h[6] + g; h[7] = h[7] + hh;
    }

    return h;
}

// ── Difficulty Check ──
// Check leading hex zeros in the hash (each u32 = 8 hex chars)

fn check_leading_zeros(hash: array<u32, 8>, required: u32) -> bool {
    var zeros_found: u32 = 0u;

    for (var w: u32 = 0u; w < 8u; w = w + 1u) {
        if (zeros_found >= required) {
            return true;
        }
        let word = hash[w];
        // Count leading hex zeros in this word (8 hex digits)
        for (var n: u32 = 0u; n < 8u; n = n + 1u) {
            let nibble = (word >> (28u - n * 4u)) & 0xFu;
            if (nibble != 0u) {
                return zeros_found >= required;
            }
            zeros_found = zeros_found + 1u;
            if (zeros_found >= required) {
                return true;
            }
        }
    }
    return zeros_found >= required;
}

// ── Main Compute Entry ──

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let thread_id = gid.x;
    if (thread_id >= params.batch_size) {
        return;
    }

    // Check if someone already found a result
    if (atomicLoad(&result[0]) != 0u) {
        return;
    }

    // Calculate nonce = base_nonce + thread_id (as u64)
    let nonce_low = params.base_nonce + thread_id;
    let nonce_high = params.base_nonce_high + select(0u, 1u, nonce_low < params.base_nonce && thread_id > 0u);

    // Clear message buffer
    for (var i: u32 = 0u; i < 32u; i = i + 1u) {
        msg[i] = 0u;
    }

    // Copy prefix into message buffer
    var pos: u32 = 0u;
    for (var i: u32 = 0u; i < params.prefix_len; i = i + 1u) {
        let b = get_prefix_byte(i);
        set_msg_byte(pos, b);
        pos = pos + 1u;
    }

    // Write nonce as decimal string
    let nonce_digits = u64_to_decimal(nonce_low, nonce_high, pos);
    pos = pos + nonce_digits;

    // Copy postfix into message buffer
    for (var i: u32 = 0u; i < params.postfix_len; i = i + 1u) {
        let b = get_postfix_byte(i);
        set_msg_byte(pos, b);
        pos = pos + 1u;
    }

    msg_len = pos;

    // Hash
    let hash = sha256_hash();

    // Check difficulty
    if (check_leading_zeros(hash, params.required_zeros)) {
        // Try to claim the result (only first thread wins)
        let prev = atomicCompareExchangeWeak(&result[0], 0u, 1u);
        if (prev.old_value == 0u) {
            atomicStore(&result[1], nonce_low);
            atomicStore(&result[2], nonce_high);
            // Store hash words
            for (var i: u32 = 0u; i < 8u; i = i + 1u) {
                atomicStore(&result[3u + i], hash[i]);
            }
        }
    }
}
