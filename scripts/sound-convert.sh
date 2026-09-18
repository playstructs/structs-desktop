#!/usr/bin/env bash
# Convert local audio drafts into the two formats every webview decodes.
#
# The sound designer (⌘K → SOUNDS) accepts WAV and MP3 only. Drafts usually
# arrive as AIFF from a DAW, so this turns every sound/*.aif|aiff|wav into
#   sound/mp3/<name>.mp3   (libmp3lame, VBR quality 2 ≈ 190 kbit/s)
#   sound/wav/<name>.wav   (16-bit PCM)
# Outputs stay under sound/, which is gitignored: nothing here is ever committed.
#
# Usage: bash scripts/sound-convert.sh [sound-dir]
set -euo pipefail

SRC_DIR="${1:-$(cd "$(dirname "$0")/.." && pwd)/sound}"
command -v ffmpeg >/dev/null 2>&1 || { echo "ffmpeg not found (brew install ffmpeg)" >&2; exit 1; }

mkdir -p "$SRC_DIR/mp3" "$SRC_DIR/wav"
shopt -s nullglob nocaseglob
n=0
for f in "$SRC_DIR"/*.aif "$SRC_DIR"/*.aiff "$SRC_DIR"/*.wav; do
  base="$(basename "${f%.*}")"
  mp3="$SRC_DIR/mp3/$base.mp3"
  wav="$SRC_DIR/wav/$base.wav"
  if [ ! -f "$mp3" ] || [ "$f" -nt "$mp3" ]; then
    ffmpeg -loglevel error -y -i "$f" -vn -codec:a libmp3lame -q:a 2 "$mp3"
    echo "mp3  $base"
  fi
  if [ ! -f "$wav" ] || [ "$f" -nt "$wav" ]; then
    ffmpeg -loglevel error -y -i "$f" -vn -c:a pcm_s16le "$wav"
    echo "wav  $base"
  fi
  n=$((n + 1))
done
echo "$n source file(s) → $SRC_DIR/{mp3,wav}"
