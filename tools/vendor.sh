#!/usr/bin/env bash
# =============================================================================
# Rebuild vendor/ — the third-party bundles the game loads with plain <script>.
# =============================================================================
# Everything is vendored rather than pulled from a CDN for three reasons:
#   1. The game has to work on a phone's flaky hotel wifi, and a CDN stall means
#      a blank screen mid-workout.
#   2. Pose detection over a CDN means a third party sees a request every time
#      you exercise. Vendoring keeps the whole thing on-device.
#   3. Pinned bytes: TF.js and the pose model are tightly coupled, and a silent
#      CDN "latest" bump is a debugging nightmare.
#
# Usage:   ./tools/vendor.sh
# Needs:   node + npm (only to download; nothing is compiled)
#
# The scratch npm tree lives in .vendor-build/ (gitignored, ~330MB). Only the
# handful of .min.js files copied into vendor/ are committed.
# -----------------------------------------------------------------------------
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"
BUILD="$ROOT/.vendor-build"
OUT="$ROOT/vendor"

# Pinned exact versions. tfjs-core / -converter / -backend-* MUST match each
# other, and pose-detection 2.1.x expects the tfjs 4.x API.
TFJS="4.22.0"
POSE="2.1.3"
PHASER="3.90.0"

mkdir -p "$BUILD" "$OUT"

cat > "$BUILD/package.json" <<JSON
{
  "name": "vendor-build",
  "private": true,
  "dependencies": {
    "@tensorflow/tfjs-core": "$TFJS",
    "@tensorflow/tfjs-converter": "$TFJS",
    "@tensorflow/tfjs-backend-webgl": "$TFJS",
    "@tensorflow/tfjs-backend-cpu": "$TFJS",
    "@tensorflow-models/pose-detection": "$POSE",
    "phaser": "$PHASER"
  }
}
JSON

echo "==> installing into .vendor-build (this is the slow part)"
( cd "$BUILD" && npm install --no-audit --no-fund --loglevel=error )

copy() {
  local src="$BUILD/node_modules/$1"
  local dst="$OUT/$2"
  if [ ! -f "$src" ]; then
    echo "!! missing $src" >&2
    echo "   The package layout changed — check the dist/ directory names." >&2
    exit 1
  fi
  cp "$src" "$dst"
  printf '    %-28s %6s KB\n' "$2" "$(( ($(wc -c < "$dst") + 1023) / 1024 ))"
}

echo "==> copying bundles into vendor/"
# Load order matters at runtime (see the <script> tags in index.html): core,
# then converter, then the backends that register themselves against core.
copy "@tensorflow/tfjs-core/dist/tf-core.min.js"                  "tf-core.min.js"
copy "@tensorflow/tfjs-converter/dist/tf-converter.min.js"        "tf-converter.min.js"
copy "@tensorflow/tfjs-backend-webgl/dist/tf-backend-webgl.min.js" "tf-backend-webgl.min.js"
copy "@tensorflow/tfjs-backend-cpu/dist/tf-backend-cpu.min.js"    "tf-backend-cpu.min.js"
copy "@tensorflow-models/pose-detection/dist/pose-detection.min.js" "pose-detection.min.js"
copy "phaser/dist/phaser.min.js"                                  "phaser.min.js"

echo "==> done. vendor/ is $(du -sh "$OUT" | cut -f1)"
echo
echo "Note: MoveNet's WEIGHTS are still fetched from TF Hub on first run and"
echo "cached by the browser. To go fully offline see README \"Running fully"
echo "offline\"."
