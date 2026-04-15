#!/bin/bash
# Sign the bundled .app so macOS preserves notification permissions across rebuilds
set -e

APP_PATH="src-tauri/target/release/bundle/macos/Structs.app"
IDENTITY="E780C31679B9F2E2D2A4DD1D339E944129DB58E0"

if [ ! -d "$APP_PATH" ]; then
  echo "Error: $APP_PATH not found. Run 'npm run tauri:build' first."
  exit 1
fi

echo "==> Signing $APP_PATH with identity '$IDENTITY'..."
codesign --force --deep -s "$IDENTITY" "$APP_PATH"
echo "==> Signed successfully."
