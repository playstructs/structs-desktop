#!/usr/bin/env bash
# Regenerate src-tauri/src/mcp/structs_chain.binpb — the chain's protobuf
# FileDescriptorSet that the native signer (mcp/chain_codec.rs) uses to turn
# JSON message payloads into bytes. No per-message Rust code, no protoc at
# build time: this file is committed and embedded with include_bytes!.
#
# Source: the structs chain repo's proto tree (default: ../structs/proto next
# to this checkout). Re-run after a chain upgrade that adds or changes Msg types.
#
#   scripts/gen-chain-descriptor.sh [path/to/structs/proto]
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
PROTO_DIR="${1:-$HERE/../structs/proto}"
OUT="$HERE/src-tauri/src/mcp/structs_chain.binpb"
command -v buf >/dev/null || { echo "buf is required (brew install bufbuild/buf/buf)"; exit 1; }
[ -f "$PROTO_DIR/buf.yaml" ] || { echo "no buf.yaml in $PROTO_DIR"; exit 1; }
( cd "$PROTO_DIR" && buf build --as-file-descriptor-set --exclude-source-info -o "$OUT" )
VER="$(cd "$PROTO_DIR" && git describe --tags --always 2>/dev/null || echo unknown)"
echo "wrote $OUT ($(wc -c < "$OUT" | tr -d ' ') bytes) from $PROTO_DIR @ $VER"
