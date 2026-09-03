//! Chain message codec — JSON payload → protobuf bytes, from the chain's own
//! descriptor set, with no per-message Rust types.
//!
//! Every loop and tool builds its message as a "friendly" JSON payload
//! (camelCase or snake_case keys, enums by name or number, integers that may
//! arrive as strings), and the JS façade turned that into bytes with
//! ts-proto's `fromJSON`. This is the same step in Rust. The message
//! descriptors come from `structs_chain.binpb` — a `FileDescriptorSet` built
//! by `scripts/gen-chain-descriptor.sh` from the chain repo's proto tree and
//! embedded at compile time — and prost-reflect applies the proto3 JSON
//! mapping, which accepts both the `json_name` and the proto field name,
//! integers as strings, and enums by name or number. The payload vocabulary
//! the rest of the app speaks is therefore unchanged.
//!
//! Unknown keys are ignored (ts-proto ignores them too). An unknown type URL
//! is an error, never a silent empty message — the one thing worse than a
//! rejected transaction is an accepted one that meant nothing.

use prost::Message;
use prost_reflect::{DescriptorPool, DynamicMessage, MessageDescriptor};
use serde_json::{Map, Value};
use std::sync::LazyLock;

/// The chain's protobuf descriptors. Regenerate with
/// `scripts/gen-chain-descriptor.sh` after a chain upgrade.
static DESCRIPTOR_SET: &[u8] = include_bytes!("structs_chain.binpb");

static POOL: LazyLock<DescriptorPool> = LazyLock::new(|| {
    DescriptorPool::decode(DESCRIPTOR_SET).expect("embedded chain descriptor set is a valid FileDescriptorSet")
});

/// Descriptor for a `/structs.structs.Msg…` type URL.
pub fn descriptor(type_url: &str) -> Result<MessageDescriptor, String> {
    let name = type_url.trim_start_matches('/');
    POOL.get_message_by_name(name)
        .ok_or_else(|| format!("unknown typeUrl: {type_url} (not in the embedded chain descriptor set)"))
}

/// Number of `structs.structs.Msg*` request types the descriptor set knows —
/// a health figure, so a stale descriptor after a chain upgrade is visible.
pub fn known_message_types() -> usize {
    POOL.all_messages()
        .filter(|m| m.full_name().starts_with("structs.structs.Msg") && !m.full_name().ends_with("Response"))
        .count()
}

fn camel_case(key: &str) -> String {
    let mut out = String::with_capacity(key.len());
    let mut upper_next = false;
    for c in key.chars() {
        if c == '_' {
            upper_next = true;
        } else if upper_next {
            out.extend(c.to_uppercase());
            upper_next = false;
        } else {
            out.push(c);
        }
    }
    out
}

/// Encode `payload` as `type_url` with `creator` set to the signer's address
/// (overriding any creator the caller supplied, exactly as the JS façade did).
pub fn encode(type_url: &str, payload: &Value, creator: &str) -> Result<Vec<u8>, String> {
    let desc = descriptor(type_url)?;
    let empty = Map::new();
    let source = match payload {
        Value::Object(m) => m,
        Value::Null => &empty,
        other => return Err(format!("{type_url}: payload must be a JSON object, got {other}")),
    };
    // The chain's fields are camelCase in the proto itself (`structId`), so
    // proto3's "json_name or proto name" fallback never matches a snake_case
    // key. Callers that read a field off an LCD row (`struct_id`) and pass it
    // straight through still deserve to be understood.
    //
    // Unknown keys are dropped HERE (ts-proto ignores them too) so the decoder
    // can run strict: with unknown fields allowed, prost-reflect also drops an
    // unknown enum NAME and leaves the field at zero — an "orbit" ambit would
    // silently become "none". Strict mode turns that into an error.
    let has = |name: &str| desc.get_field_by_json_name(name).is_some() || desc.get_field_by_name(name).is_some();
    let mut merged = Map::with_capacity(source.len() + 1);
    for (k, v) in source {
        if has(k) {
            merged.insert(k.clone(), v.clone());
        } else if k.contains('_') {
            let ck = camel_case(k);
            if has(&ck) {
                merged.insert(ck, v.clone());
            }
        }
    }
    merged.insert("creator".to_string(), Value::String(creator.to_string()));
    let opts = prost_reflect::DeserializeOptions::new().deny_unknown_fields(true);
    let msg = DynamicMessage::deserialize_with_options(desc, Value::Object(merged), &opts)
        .map_err(|e| format!("{type_url}: payload does not match the chain schema: {e}"))?;
    Ok(msg.encode_to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decode(type_url: &str, bytes: &[u8]) -> DynamicMessage {
        DynamicMessage::decode(descriptor(type_url).unwrap(), bytes).unwrap()
    }

    #[test]
    fn descriptor_set_loads_and_knows_the_message_types_the_loops_use() {
        for t in [
            "/structs.structs.MsgStructBuildInitiate",
            "/structs.structs.MsgStructAttack",
            "/structs.structs.MsgPlayerSend",
            "/structs.structs.MsgPlanetExplore",
            "/structs.structs.MsgPermissionGrantOnObject",
            "/structs.structs.MsgStructOreMinerComplete",
        ] {
            assert!(descriptor(t).is_ok(), "{t} missing from descriptor set");
        }
        assert!(known_message_types() >= 30, "expected the chain's Msg catalogue, got {}", known_message_types());
    }

    #[test]
    fn creator_is_always_the_signer() {
        let bytes = encode(
            "/structs.structs.MsgStructActivate",
            &serde_json::json!({ "structId": "1-5", "creator": "structs1attacker" }),
            "structs1signer",
        )
        .unwrap();
        let msg = decode("/structs.structs.MsgStructActivate", &bytes);
        assert_eq!(msg.get_field_by_name("creator").unwrap().as_str(), Some("structs1signer"));
    }

    #[test]
    fn snake_case_and_camel_case_keys_encode_identically() {
        let a = encode(
            "/structs.structs.MsgStructActivate",
            &serde_json::json!({ "structId": "1-5" }),
            "structs1signer",
        )
        .unwrap();
        let b = encode(
            "/structs.structs.MsgStructActivate",
            &serde_json::json!({ "struct_id": "1-5" }),
            "structs1signer",
        )
        .unwrap();
        assert_eq!(a, b);
        assert!(!a.is_empty());
    }

    #[test]
    fn integers_as_strings_and_numbers_encode_identically() {
        // Loop payloads carry `slot` as a number and `charge_cost`-style
        // values as strings depending on where they were read from.
        let t = "/structs.structs.MsgStructBuildInitiate";
        let a = encode(
            t,
            &serde_json::json!({ "playerId": "1-272", "structTypeId": "7", "operatingAmbit": 4, "slot": 3 }),
            "structs1signer",
        )
        .unwrap();
        let b = encode(
            t,
            &serde_json::json!({ "playerId": "1-272", "structTypeId": "7", "operatingAmbit": 4, "slot": "3" }),
            "structs1signer",
        )
        .unwrap();
        assert_eq!(a, b);
    }

    #[test]
    fn enums_encode_by_name_or_number() {
        let t = "/structs.structs.MsgStructBuildInitiate";
        let by_number = encode(t, &serde_json::json!({ "playerId": "1-272", "structTypeId": 7, "operatingAmbit": 4, "slot": 0 }), "s").unwrap();
        let by_name = encode(t, &serde_json::json!({ "playerId": "1-272", "structTypeId": 7, "operatingAmbit": "space", "slot": 0 }), "s").unwrap();
        assert_eq!(by_number, by_name);
        // Same as ts-proto, whose ambitFromJSON("4") is UNRECOGNIZED: a numeric
        // string is not an enum value. Rust sends enums as integers.
        assert!(encode(t, &serde_json::json!({ "playerId": "1-272", "operatingAmbit": "4" }), "s").is_err());
        // An unknown NAME is refused, never silently zeroed to "none".
        assert!(encode(t, &serde_json::json!({ "playerId": "1-272", "operatingAmbit": "orbit" }), "s").is_err());
    }

    #[test]
    fn unknown_keys_are_ignored_like_ts_proto() {
        let bytes = encode(
            "/structs.structs.MsgStructActivate",
            &serde_json::json!({ "structId": "1-5", "charge_cost": 3, "note": "ignored" }),
            "structs1signer",
        )
        .unwrap();
        let plain = encode(
            "/structs.structs.MsgStructActivate",
            &serde_json::json!({ "structId": "1-5" }),
            "structs1signer",
        )
        .unwrap();
        assert_eq!(bytes, plain);
    }

    #[test]
    fn unknown_type_url_is_an_error_not_an_empty_message() {
        let err = encode("/structs.structs.MsgDoesNotExist", &serde_json::json!({}), "structs1x").unwrap_err();
        assert!(err.contains("unknown typeUrl"), "{err}");
    }

    #[test]
    fn a_non_object_payload_is_rejected() {
        let err = encode("/structs.structs.MsgStructActivate", &serde_json::json!("1-5"), "structs1x").unwrap_err();
        assert!(err.contains("must be a JSON object"), "{err}");
    }
}
