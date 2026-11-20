#!/usr/bin/env bash
# shot.sh OUT.png 'JSON params' [W] [H] [cold]  — screenshot the Telemetry card
# (server must be running: cd frontend && python3 -m http.server 8899 --bind 127.0.0.1)
# Headless Chrome sometimes hangs under parallel load: each try is killed after
# 25 s and retried once.
set -uo pipefail
OUT="$1"; P="${2:-{\}}"; W="${3:-1180}"; H="${4:-1400}"; COLD="${5:-}"
ENC=$(python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1]))' "$P")
URL="http://127.0.0.1:8899/_harness_tlab.html?view=terminal&card=onboarding-1&p=$ENC"
[ -n "$COLD" ] && URL="$URL&cold=$COLD"
for try in 1 2; do
  PROFILE="$(mktemp -d)"
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu --hide-scrollbars \
    --user-data-dir="$PROFILE" --force-device-scale-factor=1 --window-size="$W,$H" --virtual-time-budget=5000 \
    --screenshot="$OUT" "$URL" >/dev/null 2>&1 &
  PID=$!
  for i in $(seq 1 50); do sleep 0.5; kill -0 "$PID" 2>/dev/null || break; done
  if kill -0 "$PID" 2>/dev/null; then pkill -f -- "--user-data-dir=$PROFILE" ; kill "$PID" 2>/dev/null; rm -rf "$PROFILE"; continue; fi
  rm -rf "$PROFILE"; [ -s "$OUT" ] && break
done
echo "$OUT"
