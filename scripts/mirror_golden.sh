#!/usr/bin/env bash
# Regenerate src-tauri/src/mirror/golden/difficulty.json from the chain's own
# CalculateDifficulty. Run after every chain upgrade that touches work.go:
#
#   STRUCTS=../structs scripts/mirror_golden.sh
#
# work.go is stdlib-only, so it is compiled verbatim (package renamed) next to
# scripts/mirror_golden/main.go — no Cosmos dependency tree, no network.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/.." && pwd)"
structs="${STRUCTS:-$repo/../structs}"
work="$structs/x/structs/types/work.go"
out="$repo/src-tauri/src/mirror/golden/difficulty.json"

[ -f "$work" ] || { echo "no work.go at $work (set STRUCTS=<structsd checkout>)" >&2; exit 1; }

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
sed 's/^package types$/package main/' "$work" > "$tmp/work.go"
cp "$here/mirror_golden/main.go" "$tmp/main.go"
printf 'module mirrorgolden\n\ngo 1.21\n' > "$tmp/go.mod"

version="$(git -C "$structs" describe --tags --always 2>/dev/null || echo unknown)"
sha="$(shasum -a 256 "$work" | cut -d' ' -f1)"

(cd "$tmp" && GOFLAGS=-mod=mod GOLDEN_SOURCE="structsd $version x/structs/types/work.go" GOLDEN_SHA="$sha" go run .) > "$out"
echo "wrote $out ($(wc -c < "$out") bytes) from structsd $version"
