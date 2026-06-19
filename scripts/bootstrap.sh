#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CSMAP_REPO="$ROOT/vendor/csmap"
PATCH_FILE="$ROOT/patches/csmap-macos-clang.patch"

if ! command -v pkg-config >/dev/null 2>&1; then
  echo "pkg-config is required. Install it first, then rerun this script." >&2
  exit 1
fi

if ! pkg-config --exists proj; then
  if command -v brew >/dev/null 2>&1; then
    brew install proj
  else
    echo "PROJ was not found and Homebrew is unavailable." >&2
    exit 1
  fi
fi

if [ ! -d "$CSMAP_REPO/.git" ]; then
  mkdir -p "$ROOT/vendor"
  if [ -d "$ROOT/../csmap/.git" ]; then
    git clone "$ROOT/../csmap" "$CSMAP_REPO"
  else
    git clone https://github.com/eharris/csmap "$CSMAP_REPO"
  fi
fi

if git -C "$CSMAP_REPO" apply --check --ignore-space-change "$PATCH_FILE" >/dev/null 2>&1; then
  git -C "$CSMAP_REPO" apply --ignore-space-change "$PATCH_FILE"
elif git -C "$CSMAP_REPO" apply --reverse --check --ignore-space-change "$PATCH_FILE" >/dev/null 2>&1; then
  echo "CS-MAP macOS patch already applied."
else
  echo "CS-MAP patch does not apply cleanly. Inspect $PATCH_FILE and $CSMAP_REPO." >&2
  exit 1
fi

make -C "$ROOT" test
