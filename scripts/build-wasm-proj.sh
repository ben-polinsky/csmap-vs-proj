#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# shellcheck disable=SC1091
source "$ROOT/scripts/wasm-env.sh"

wasm_require_toolchain
wasm_require_host_tools cmake curl make sqlite3 tar

PROJ_VERSION="${PROJ_VERSION:-9.8.1}"
WASM_DIR="$(wasm_abs_path "$ROOT" "${WASM_DIR:-wasm}")"
WASM_VENDOR_DIR="$(wasm_abs_path "$ROOT" "${WASM_VENDOR_DIR:-$WASM_DIR/vendor}")"
WASM_BUILD_DIR="$(wasm_abs_path "$ROOT" "${WASM_BUILD_DIR:-$WASM_DIR/build}")"
SRC_ARCHIVE="$WASM_VENDOR_DIR/proj-$PROJ_VERSION.tar.gz"
SRC_DIR="$WASM_VENDOR_DIR/proj-$PROJ_VERSION"
BUILD_DIR="$WASM_BUILD_DIR/proj-$PROJ_VERSION"
INSTALL_DIR="$WASM_DIR/dist/proj"
URL="https://download.osgeo.org/proj/proj-$PROJ_VERSION.tar.gz"

mkdir -p "$WASM_VENDOR_DIR" "$BUILD_DIR" "$INSTALL_DIR"

if [ ! -d "$SRC_DIR" ]; then
  if [ ! -f "$SRC_ARCHIVE" ]; then
    echo "Downloading PROJ $PROJ_VERSION from $URL"
    curl -fL "$URL" -o "$SRC_ARCHIVE"
  fi
  tar -xzf "$SRC_ARCHIVE" -C "$WASM_VENDOR_DIR"
fi

# PROJ requires SQLite both at configure time and final link time. Emscripten
# ships SQLite as a port, but CMake will not see it until the port is seeded.
SQLITE_PROBE="$BUILD_DIR/sqlite-port-probe"
printf 'int main(void) { return 0; }\n' | emcc -xc - -sUSE_SQLITE3=1 -o "$SQLITE_PROBE.js" >/dev/null
rm -f "$SQLITE_PROBE.js" "$SQLITE_PROBE.wasm"

SQLITE_INCLUDE="$EMSDK/upstream/emscripten/cache/sysroot/include"
SQLITE_LIBRARY="$EMSDK/upstream/emscripten/cache/sysroot/lib/wasm32-emscripten/libsqlite3.a"
if [ ! -f "$SQLITE_INCLUDE/sqlite3.h" ] || [ ! -f "$SQLITE_LIBRARY" ]; then
  echo "Emscripten SQLite3 port did not produce the expected include/archive." >&2
  exit 1
fi

emcmake cmake -S "$SRC_DIR" -B "$BUILD_DIR" \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_INSTALL_PREFIX="$INSTALL_DIR" \
  -DCMAKE_C_FLAGS="-pthread" \
  -DCMAKE_CXX_FLAGS="-pthread" \
  -DCMAKE_EXE_LINKER_FLAGS="-pthread -sUSE_SQLITE3=1" \
  -DSQLite3_INCLUDE_DIR="$SQLITE_INCLUDE" \
  -DSQLite3_LIBRARY="$SQLITE_LIBRARY" \
  -DBUILD_SHARED_LIBS=OFF \
  -DBUILD_APPS=OFF \
  -DBUILD_TESTING=OFF \
  -DENABLE_CURL=OFF \
  -DENABLE_TIFF=OFF \
  -DENABLE_EMSCRIPTEN_FETCH=ON \
  -DEMBED_PROJ_DATA_PATH=OFF \
  -DEMBED_RESOURCE_FILES=ON \
  -DUSE_ONLY_EMBEDDED_RESOURCE_FILES=OFF

emmake cmake --build "$BUILD_DIR" --target install -j"${WASM_BUILD_JOBS:-${JOBS:-4}}"

if [ ! -f "$INSTALL_DIR/lib/libproj.a" ]; then
  echo "Expected PROJ archive was not produced: $INSTALL_DIR/lib/libproj.a" >&2
  exit 1
fi

echo "PROJ WASM archive: $INSTALL_DIR/lib/libproj.a"
