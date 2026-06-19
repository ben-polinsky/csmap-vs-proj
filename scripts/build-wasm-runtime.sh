#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# shellcheck disable=SC1091
source "$ROOT/scripts/wasm-env.sh"

wasm_require_toolchain

WASM_DIR="$(wasm_abs_path "$ROOT" "${WASM_DIR:-wasm}")"
WASM_DATA_DIR="$(wasm_abs_path "$ROOT" "${WASM_DATA_DIR:-web/wasm-data}")"
OUT_DIR="$ROOT/web/wasm"
CSMAP_LIB="$(wasm_abs_path "$ROOT" "${CSMAP_WASM_LIB:-$WASM_DIR/dist/csmap/CsMap.a}")"
PROJ_PREFIX="$(wasm_abs_path "$ROOT" "${PROJ_WASM_PREFIX:-$WASM_DIR/dist/proj}")"

if [ ! -f "$CSMAP_LIB" ]; then
  echo "missing CS-MAP WASM archive: $CSMAP_LIB" >&2
  exit 1
fi

if [ ! -f "$PROJ_PREFIX/lib/libproj.a" ]; then
  echo "missing PROJ WASM archive: $PROJ_PREFIX/lib/libproj.a" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"

em++ -O3 -std=c++17 -pthread -fexceptions \
  -I"$ROOT/vendor/csmap/CsMapDev/Include" \
  -I"$PROJ_PREFIX/include" \
  "$ROOT/src/compare_core.cpp" \
  "$ROOT/src/wasm_compare.cpp" \
  "$CSMAP_LIB" \
  "$PROJ_PREFIX/lib/libproj.a" \
  -sMODULARIZE=1 \
  -sEXPORT_ES6=1 \
  -sENVIRONMENT=worker \
  -sALLOW_MEMORY_GROWTH=1 \
  -sDISABLE_EXCEPTION_CATCHING=0 \
  -sFORCE_FILESYSTEM=1 \
  -sFETCH=1 \
  -sUSE_SQLITE3=1 \
  -sUSE_PTHREADS=1 \
  -sPTHREAD_POOL_SIZE=2 \
  -sEXPORTED_FUNCTIONS='["_compare_json","_free_result","_malloc","_free"]' \
  -sEXPORTED_RUNTIME_METHODS='["FS","UTF8ToString","stringToUTF8","lengthBytesUTF8"]' \
  --preload-file "$WASM_DATA_DIR/csmap/core@/csmap" \
  --preload-file "$WASM_DATA_DIR/proj/core@/proj" \
  -o "$OUT_DIR/compare-runtime.js"

echo "WASM runtime written to $OUT_DIR/compare-runtime.js"
