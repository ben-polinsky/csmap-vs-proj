#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# shellcheck disable=SC1091
source "$ROOT/scripts/wasm-env.sh"

wasm_require_toolchain
wasm_require_host_tools make

CSMAP_DEV="$(wasm_abs_path "$ROOT" "${CSMAP_DEV:-vendor/csmap/CsMapDev}")"
WASM_DIR="$(wasm_abs_path "$ROOT" "${WASM_DIR:-wasm}")"
WASM_BUILD_DIR="$(wasm_abs_path "$ROOT" "${WASM_BUILD_DIR:-$WASM_DIR/build}")"
OUT_DIR="$WASM_DIR/dist/csmap"
SHIM_DIR="$WASM_BUILD_DIR/csmap/tool-shims"

mkdir -p "$WASM_BUILD_DIR/csmap" "$OUT_DIR" "$SHIM_DIR"
ln -sf "$(command -v emar)" "$SHIM_DIR/ar"

pushd "$CSMAP_DEV/Source" >/dev/null
PATH="$SHIM_DIR:$PATH" \
  emmake make -f Library.mak \
    CC=emcc \
    CXX=em++ \
    VERSION=47 \
    CONFIGURATION=Emscripten \
    PROCESSOR=wasm \
    OUT_DIR="$OUT_DIR" \
    INT_DIR="$WASM_BUILD_DIR/csmap/obj" \
    SRC_DIR="$CSMAP_DEV/Source/" \
    C_FLG="${CSMAP_WASM_CFLAGS:--c -O2 -pthread -I../Include}" \
    CXX_FLG="${CSMAP_WASM_CXXFLAGS:--c -O2 -pthread -std=c++17 -I../Include}"
popd >/dev/null

if [ ! -f "$OUT_DIR/CsMap.a" ]; then
  echo "Expected CS-MAP archive was not produced: $OUT_DIR/CsMap.a" >&2
  exit 1
fi

echo "CS-MAP WASM archive: $OUT_DIR/CsMap.a"
