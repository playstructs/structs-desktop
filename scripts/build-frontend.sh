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

# Check if frontend/js/index.js exists (i.e., sync has been run at least once)
if [ ! -f "$FRONTEND_DIR/js/index.js" ]; then
  echo "Frontend not built yet. Running full sync..."
  bash "$SCRIPT_DIR/sync.sh"
else
  echo "Frontend already built. Skipping (run 'npm run sync' to rebuild)."
fi
