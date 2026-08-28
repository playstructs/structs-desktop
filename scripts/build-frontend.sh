#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
FRONTEND_DIR="$PROJECT_DIR/frontend"

# Harness artefacts are gitignored but live in frontend/, which IS frontendDist —
# so a build started while they exist ships fixture data and a stubbed
# __TAURI__ inside the app bundle. This is the one command every build runs, so
# the cleanup belongs here rather than in a note someone has to remember.
rm -f "$FRONTEND_DIR"/_harness*.html "$FRONTEND_DIR"/_fixtures*.js

# The webapp bundle is only rebuilt by sync.sh, and sync.sh is the ONLY thing
# that runs apply-patches.sh. So a build that skips the sync ships a bundle
# missing any patch added since the last one — silently, because the façade it
# was supposed to install simply isn't there and the feature fails at runtime
# with "façade unavailable". That cost a full signed rebuild the first time it
# bit (the Comms login façade, 2026-08-28), so staleness is now detected rather
# than remembered.
if [ ! -f "$FRONTEND_DIR/js/index.js" ]; then
  echo "Frontend not built yet. Running full sync..."
  bash "$SCRIPT_DIR/sync.sh"
elif [ "$SCRIPT_DIR/apply-patches.sh" -nt "$FRONTEND_DIR/js/index.js" ]; then
  echo "Patches changed since the last sync — re-syncing so they reach the bundle."
  bash "$SCRIPT_DIR/sync.sh"
else
  echo "Frontend already built and patches unchanged. Skipping (run 'npm run sync' to force)."
fi
