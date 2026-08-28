#!/usr/bin/env bash
# =============================================================================
# Fetch MediaPipe Tasks Vision (PoseLandmarker) into vendor/
# =============================================================================
# Run:  ./tools/vendor-mediapipe.sh
#
# Companion to tools/vendor.sh, and split out from it because MediaPipe's
# payload is a different shape and a different order of magnitude.
#
# WHAT LANDS WHERE, AND WHY
#
#   vendor/mediapipe/vision_bundle.js   152KB, COMMITTED
#       An IIFE that assigns a global `Vision`, which is exactly what this
#       project's plain <script> tags need — same shape as the vendored TF.js
#       files. Small enough to commit, and it is Apache 2.0 code.
#
#   vendor/mediapipe/wasm/              ~12MB, GITIGNORED
#       The WASM runtime. Note this is the whole of MediaPipe Tasks Vision —
#       face, hand, gesture, segmentation, object detection — because the
#       package ships no pose-only build. There is no smaller variant: the
#       nosimd fallback is 11MB and the module build is another 12MB.
#
#   vendor/models/pose_landmarker_*.task   ~5.7MB, GITIGNORED
#       Model weights, kept out of git for the same reason the MoveNet weights
#       are: they are a few MB and not ours to redistribute.
#
# HONEST SIZE COMPARISON, because this is a real cost and not a free upgrade:
#
#     MoveNet path    2.4MB vendored TF.js  +  ~5MB weights   =  ~7.4MB
#     MediaPipe path  152KB bundle + 12MB wasm + 5.7MB model  = ~17.9MB
#
# So roughly 2.4x the first-load download. If MediaPipe becomes the only
# backend, the TF.js files can be dropped, which claws back 2.4MB and no more.
# Decide that after measuring both on a real phone — see js/config.js
# pose.backend, which exists precisely so both can be compared.
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_JS="$ROOT/vendor/mediapipe"
OUT_WASM="$OUT_JS/wasm"
OUT_MODELS="$ROOT/vendor/models"

# Pin the variants deliberately.
#
# LITE, not Full or Heavy. Published latency on a Pixel 3 is 53ms for Heavy
# (~19fps) and 25ms for Full (~40fps), and this game's cadence detector needs
# 20fps+ to resolve a running step pattern at all — measured: at 12fps it
# reports a sprint as zero rather than guess. Heavy sits right on that cliff.
# Lite is the smallest and fastest and is the sane default for a game.
MODEL_VARIANT="${MODEL_VARIANT:-pose_landmarker_lite}"
MODEL_URL="https://storage.googleapis.com/mediapipe-models/pose_landmarker/${MODEL_VARIANT}/float16/1/${MODEL_VARIANT}.task"

echo "==> resolving @mediapipe/tasks-vision"
VER="$(curl -fsSL --max-time 60 https://registry.npmjs.org/@mediapipe/tasks-vision \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['dist-tags']['latest'])")"
TARBALL="$(curl -fsSL --max-time 60 "https://registry.npmjs.org/@mediapipe/tasks-vision/$VER" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['dist']['tarball'])")"
echo "    version $VER"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "==> downloading package"
curl -fsSL --max-time 300 -o "$TMP/pkg.tgz" "$TARBALL"
tar xzf "$TMP/pkg.tgz" -C "$TMP"

mkdir -p "$OUT_JS" "$OUT_WASM" "$OUT_MODELS"
cp "$TMP/package/vision_bundle.js" "$OUT_JS/"
# Both the SIMD build and the nosimd fallback: the loader picks at runtime by
# feature detection, and a phone without SIMD would otherwise fail to start.
cp "$TMP/package/wasm/vision_wasm_internal.js" \
   "$TMP/package/wasm/vision_wasm_internal.wasm" \
   "$TMP/package/wasm/vision_wasm_nosimd_internal.js" \
   "$TMP/package/wasm/vision_wasm_nosimd_internal.wasm" \
   "$OUT_WASM/"

echo "$VER" > "$OUT_JS/VERSION"

echo "==> downloading model ($MODEL_VARIANT)"
curl -fsSL --max-time 300 -o "$OUT_MODELS/${MODEL_VARIANT}.task" "$MODEL_URL"

echo ""
echo "vendored:"
du -h "$OUT_JS/vision_bundle.js" "$OUT_WASM"/*.wasm "$OUT_MODELS/${MODEL_VARIANT}.task" 2>/dev/null || true
echo ""
echo "Committed:  vendor/mediapipe/vision_bundle.js"
echo "Gitignored: vendor/mediapipe/wasm/  vendor/models/   (re-run this script)"
echo ""
echo "Enable it with  ?pose=mediapipe  or  pose.backend in js/config.js"
