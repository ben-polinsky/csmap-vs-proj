#!/usr/bin/env bash

wasm_repo_root() {
  cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd
}

wasm_log() {
  printf '%s\n' "$*" >&2
}

wasm_abs_path() {
  local root="$1"
  local value="$2"

  case "$value" in
    /*) printf '%s\n' "$value" ;;
    *) printf '%s\n' "$root/$value" ;;
  esac
}

wasm_find_emsdk() {
  local root="$1"
  local candidates=()

  if [ -n "${EMSDK:-}" ]; then
    candidates+=("$EMSDK")
  fi

  candidates+=(
    "$root/wasm/vendor/emsdk"
    "$root/vendor/emsdk"
    "$root/../emsdk"
    "$HOME/source/emsdk"
    "$HOME/emsdk"
  )

  local candidate
  for candidate in "${candidates[@]}"; do
    if [ -f "$candidate/emsdk_env.sh" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  return 1
}

wasm_activate_emsdk() {
  local root="$1"

  if command -v emcc >/dev/null 2>&1; then
    return 0
  fi

  local emsdk_dir
  if emsdk_dir="$(wasm_find_emsdk "$root")"; then
    # emsdk_env.sh updates PATH and EMSDK_* variables in this shell.
    # Keep this quiet so Make output stays focused on the active target.
    # shellcheck disable=SC1091
    source "$emsdk_dir/emsdk_env.sh" >/dev/null
  fi
}

wasm_missing_tools() {
  local missing=()
  local tool

  for tool in "$@"; do
    if ! command -v "$tool" >/dev/null 2>&1; then
      missing+=("$tool")
    fi
  done

  if [ "${#missing[@]}" -gt 0 ]; then
    printf '%s\n' "${missing[@]}"
    return 1
  fi

  return 0
}

wasm_require_host_tools() {
  local missing

  if ! missing="$(wasm_missing_tools "$@")"; then
    wasm_log "Missing required host tool(s):"
    while IFS= read -r tool; do
      [ -n "$tool" ] && wasm_log "  - $tool"
    done <<< "$missing"
    return 1
  fi
}

wasm_require_toolchain() {
  local root
  root="$(wasm_repo_root)"

  wasm_activate_emsdk "$root"

  local missing
  if ! missing="$(wasm_missing_tools emcc em++ emar emcmake emmake)"; then
    wasm_log "Emscripten is required for the WASM build, but the active shell does not expose the full toolchain."
    wasm_log ""
    wasm_log "Missing tool(s):"
    while IFS= read -r tool; do
      [ -n "$tool" ] && wasm_log "  - $tool"
    done <<< "$missing"
    wasm_log ""
    wasm_log "Checked PATH first, then local emsdk candidates:"
    wasm_log "  - ${EMSDK:-<EMSDK is not set>}"
    wasm_log "  - $root/wasm/vendor/emsdk"
    wasm_log "  - $root/vendor/emsdk"
    wasm_log "  - $root/../emsdk"
    wasm_log "  - $HOME/source/emsdk"
    wasm_log "  - $HOME/emsdk"
    wasm_log ""
    wasm_log "Install or activate emsdk, then rerun the target. A repo-local install can live under ignored build output:"
    wasm_log "  git clone https://github.com/emscripten-core/emsdk.git $root/wasm/vendor/emsdk"
    wasm_log "  $root/wasm/vendor/emsdk/emsdk install latest"
    wasm_log "  $root/wasm/vendor/emsdk/emsdk activate latest"
    wasm_log "  source $root/wasm/vendor/emsdk/emsdk_env.sh"
    return 1
  fi
}
