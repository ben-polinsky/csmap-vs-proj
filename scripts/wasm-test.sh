#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# shellcheck disable=SC1091
source "$ROOT/scripts/wasm-env.sh"

WASM_DIR="$(wasm_abs_path "$ROOT" "${WASM_DIR:-wasm}")"
WASM_DATA_DIR="$(wasm_abs_path "$ROOT" "${WASM_DATA_DIR:-web/wasm-data}")"

test -f "$WASM_DIR/dist/proj/lib/libproj.a"
test -f "$WASM_DIR/dist/csmap/CsMap.a"
test -f "$WASM_DATA_DIR/manifest.json"

echo "WASM artifacts are present."
