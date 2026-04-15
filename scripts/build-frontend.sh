#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
FRONTEND_DIR="$PROJECT_DIR/frontend"

# Check if frontend/js/index.js exists (i.e., sync has been run at least once)
if [ ! -f "$FRONTEND_DIR/js/index.js" ]; then
  echo "Frontend not built yet. Running full sync..."
  bash "$SCRIPT_DIR/sync.sh"
else
  echo "Frontend already built. Skipping (run 'npm run sync' to rebuild)."
fi
