#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# shellcheck disable=SC1091
source "$ROOT/scripts/wasm-env.sh"

wasm_require_toolchain
wasm_require_host_tools cmake curl make sqlite3 tar

printf 'Emscripten toolchain detected:\n'
printf '  emcc: %s\n' "$(command -v emcc)"
printf '  em++: %s\n' "$(command -v em++)"
printf '  emar: %s\n' "$(command -v emar)"
printf '  emcmake: %s\n' "$(command -v emcmake)"
printf '  emmake: %s\n' "$(command -v emmake)"
printf '  version: %s\n' "$(emcc --version | sed -n '1p')"
