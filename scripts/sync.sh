#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
WEBAPP_DIR="$PROJECT_DIR/structs-webapp"
FRONTEND_DIR="$PROJECT_DIR/frontend"
BUILD_DIR="$PROJECT_DIR/.build-tmp"

echo "==> Updating submodules..."
cd "$PROJECT_DIR"
git submodule update --init --remote --recursive 2>/dev/null || true

# Verify webapp source exists
if [ ! -d "$WEBAPP_DIR/src/js" ]; then
  echo "ERROR: structs-webapp/src/js not found."
  echo "  WEBAPP_DIR=$WEBAPP_DIR"
  echo "  Contents of structs-webapp/:"
  ls -la "$WEBAPP_DIR/" 2>/dev/null || echo "  (directory does not exist)"
  ls -la "$WEBAPP_DIR/src/" 2>/dev/null || echo "  (src/ does not exist)"
  exit 1
fi

echo "==> Preparing build directory..."
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"

# Copy the webapp src directory for patching and building
cp -r "$WEBAPP_DIR/src/js" "$BUILD_DIR/js"
cp "$WEBAPP_DIR/src/package.json" "$BUILD_DIR/package.json"
cp "$WEBAPP_DIR/src/package-lock.json" "$BUILD_DIR/package-lock.json" 2>/dev/null || true
cp "$WEBAPP_DIR/src/webpack.config.js" "$BUILD_DIR/webpack.config.js"
cp "$WEBAPP_DIR/src/tsconfig.json" "$BUILD_DIR/tsconfig.json"

echo "==> Applying patches..."
bash "$SCRIPT_DIR/apply-patches.sh" "$BUILD_DIR"

echo "==> Installing dependencies..."
cd "$BUILD_DIR"
npm install

echo "==> Building with webpack..."
npx webpack --mode=production --no-devtool

echo "==> Stripping source maps (defense in depth)..."
find "$BUILD_DIR/public/js" -name '*.map' -delete 2>/dev/null || true
find "$BUILD_DIR/public/js" -name '*.js' -exec \
  sed -i.bak -E 's|^[[:space:]]*//[#@] sourceMappingURL=.*$||' {} \;
find "$BUILD_DIR/public/js" -name '*.bak' -delete 2>/dev/null || true

echo "==> Assembling frontend directory..."
# Keep index.html and structs-config.js (they're maintained in the repo)
# Clear and rebuild the rest
rm -rf "$FRONTEND_DIR/css" "$FRONTEND_DIR/fonts" "$FRONTEND_DIR/img" "$FRONTEND_DIR/lottie" "$FRONTEND_DIR/structicons" "$FRONTEND_DIR/js"

# Copy static assets from webapp
cp -r "$WEBAPP_DIR/src/public/css" "$FRONTEND_DIR/css"
cp -r "$WEBAPP_DIR/src/public/fonts" "$FRONTEND_DIR/fonts"
cp -r "$WEBAPP_DIR/src/public/img" "$FRONTEND_DIR/img"
cp -r "$WEBAPP_DIR/src/public/lottie" "$FRONTEND_DIR/lottie" 2>/dev/null || true
cp -r "$WEBAPP_DIR/src/public/structicons" "$FRONTEND_DIR/structicons" 2>/dev/null || true

# Copy webpack build output
mkdir -p "$FRONTEND_DIR/js"
cp -r "$BUILD_DIR/public/js/"* "$FRONTEND_DIR/js/"

# Copy vendor scripts that aren't part of webpack
cp "$WEBAPP_DIR/src/public/js/plugins.js" "$FRONTEND_DIR/js/plugins.js"
cp "$WEBAPP_DIR/src/public/js/main.js" "$FRONTEND_DIR/js/main.js"
mkdir -p "$FRONTEND_DIR/js/vendor"
cp "$WEBAPP_DIR/src/public/js/vendor/liga.js" "$FRONTEND_DIR/js/vendor/liga.js"
cp "$WEBAPP_DIR/src/public/js/vendor/lottie-5.12.2.min.js" "$FRONTEND_DIR/js/vendor/lottie-5.12.2.min.js" 2>/dev/null || true

echo "==> Syncing compendium..."
COMPENDIUM_SRC="$PROJECT_DIR/structs-ai"
COMPENDIUM_DST="$HOME/.config/structs-app/compendium"
if [ -d "$COMPENDIUM_SRC" ]; then
  rm -rf "$COMPENDIUM_DST"
  mkdir -p "$COMPENDIUM_DST"
  for dir in knowledge playbooks patterns awareness protocols schemas api skills; do
    [ -d "$COMPENDIUM_SRC/$dir" ] && cp -rL "$COMPENDIUM_SRC/$dir" "$COMPENDIUM_DST/" 2>/dev/null || true
  done
  for f in QUICKSTART.md AGENTS.md TOOLS.md COMMANDER.md CHANGELOG.md; do
    cp "$COMPENDIUM_SRC/$f" "$COMPENDIUM_DST/" 2>/dev/null || true
  done
  echo "    Compendium synced to $COMPENDIUM_DST"
else
  echo "    Compendium source not found at $COMPENDIUM_SRC (skipping)"
fi

echo "==> Cleaning up..."
rm -rf "$BUILD_DIR"

echo "==> Done! Frontend assembled in $FRONTEND_DIR"
