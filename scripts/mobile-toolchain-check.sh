#!/usr/bin/env bash
# Toolchain check for the mobile-app plan (docs/plans/2026-10-15-mobile-app).
# Usage: scripts/mobile-toolchain-check.sh --phase 2|12|13|14 [--android]
# Prints "OK <name>" or "MISSING <name> — <install command>" for every tool the
# given phase (and the phases before it) needs, and exits 1 if any is missing.
# --android also reports the Android toolchain as INFO lines; it never fails
# the run in this plan (M10 makes it required).
set -euo pipefail

# Pinned license tooling. Phase 3.3's CI step must install these exact
# versions so local and CI output stay byte-identical. cargo-about only builds
# its binary with the "cli" feature, so install it on its own:
#   cargo install cargo-deny@0.20.2 --locked
#   cargo install cargo-about@0.9.2 --locked --features cli
CARGO_DENY_VERSION=0.20.2
CARGO_ABOUT_VERSION=0.9.2

MIN_XCODE_MAJOR=26
MIN_NODE_MAJOR=20
MIN_NDK_MAJOR=28

usage() {
  echo "usage: scripts/mobile-toolchain-check.sh --phase 2|12|13|14 [--android]" >&2
  exit 2
}

phase=""
android=0
while [ $# -gt 0 ]; do
  case "$1" in
    --phase)
      [ $# -ge 2 ] || usage
      case "$2" in
        2 | 12 | 13 | 14) phase="$2" ;;
        *) usage ;;
      esac
      shift 2
      ;;
    --android)
      android=1
      shift
      ;;
    *) usage ;;
  esac
done
[ -n "$phase" ] || usage

missing=0

ok() { echo "OK $1"; }
miss() {
  echo "MISSING $1 — $2"
  missing=1
}

# Leading integer of a version string ("v22.21.1" -> 22, "27.0" -> 27), 0 if none.
major() {
  local m
  m="$(sed -nE 's/^[^0-9]*([0-9]+).*/\1/p' <<<"$1")"
  echo "${m:-0}"
}

# Exact-version check for a cargo subcommand binary ("cargo-deny 0.20.2").
# Optional third arg: extra `cargo install` flags.
check_cargo_tool() {
  local bin="$1" want="$2" have
  local install="cargo install $bin@$want --locked${3:+ $3}"
  if ! command -v "$bin" >/dev/null 2>&1; then
    miss "$bin" "$install"
    return
  fi
  have="$("$bin" --version 2>/dev/null | head -n 1 | awk '{print $NF}' || true)"
  if [ "$have" = "$want" ]; then
    ok "$bin $have"
  else
    miss "$bin (found ${have:-unknown}, need $want)" "$install"
  fi
}

installed_targets=""
if command -v rustup >/dev/null 2>&1; then
  installed_targets="$(rustup target list --installed 2>/dev/null || true)"
fi

check_target() {
  if grep -qx "$1" <<<"$installed_targets"; then
    ok "rustup target $1"
  else
    miss "rustup target $1" "rustup target add $1"
  fi
}

check_xcode() {
  local install="install Xcode $MIN_XCODE_MAJOR or newer, then: sudo xcode-select -s /Applications/Xcode.app"
  local have
  have="$(xcodebuild -version 2>/dev/null | awk '/^Xcode /{print $2; exit}' || true)"
  if [ -z "$have" ]; then
    miss "Xcode >= $MIN_XCODE_MAJOR" "$install"
  elif [ "$(major "$have")" -ge "$MIN_XCODE_MAJOR" ]; then
    ok "Xcode $have"
  else
    miss "Xcode >= $MIN_XCODE_MAJOR (found $have)" "$install"
  fi
}

check_node() {
  local install="brew install node"
  local have
  have="$(node --version 2>/dev/null || true)"
  if [ -z "$have" ]; then
    miss "Node >= $MIN_NODE_MAJOR" "$install"
  elif [ "$(major "$have")" -ge "$MIN_NODE_MAJOR" ]; then
    ok "Node $have"
  else
    miss "Node >= $MIN_NODE_MAJOR (found $have)" "$install"
  fi
}

check_maestro() {
  if command -v maestro >/dev/null 2>&1; then
    ok "maestro"
  else
    miss "maestro" "curl -fsSL https://get.maestro.mobile.dev | bash"
  fi
}

check_booted_simulator() {
  if xcrun simctl list devices booted 2>/dev/null | grep -q "(Booted)"; then
    ok "booted iOS simulator"
  else
    miss "booted iOS simulator" "open -a Simulator (or: xcrun simctl boot <device>)"
  fi
}

# Android: reported only, never counted as missing (required from M10).
info() { echo "INFO $1 (required from M10)"; }

check_android() {
  local t have
  for t in aarch64-linux-android x86_64-linux-android; do
    if grep -qx "$t" <<<"$installed_targets"; then
      info "rustup target $t: ok"
    else
      info "rustup target $t: missing — rustup target add $t"
    fi
  done

  if command -v cargo-ndk >/dev/null 2>&1; then
    info "cargo-ndk: ok"
  else
    info "cargo-ndk: missing — cargo install cargo-ndk --locked"
  fi

  local ndk_install="sdkmanager \"ndk;28.x\" and export ANDROID_NDK_HOME"
  local props="${ANDROID_NDK_HOME:-}/source.properties"
  if [ -z "${ANDROID_NDK_HOME:-}" ]; then
    info "ANDROID_NDK_HOME: not set — $ndk_install"
  elif [ ! -f "$props" ]; then
    info "ANDROID_NDK_HOME: $props not found — $ndk_install"
  else
    have="$(awk -F= '/^Pkg.Revision/{gsub(/[[:space:]]/, "", $2); print $2; exit}' "$props")"
    if [ -n "$have" ] && [ "$(major "$have")" -ge "$MIN_NDK_MAJOR" ]; then
      info "Android NDK $have: ok"
    else
      info "Android NDK ${have:-unknown}: need r$MIN_NDK_MAJOR or newer — $ndk_install"
    fi
  fi
}

if [ "$phase" -ge 2 ]; then
  check_cargo_tool cargo-deny "$CARGO_DENY_VERSION"
  check_cargo_tool cargo-about "$CARGO_ABOUT_VERSION" "--features cli"
fi

if [ "$phase" -ge 12 ]; then
  check_target aarch64-apple-ios
  check_target aarch64-apple-ios-sim
  check_xcode
fi

if [ "$phase" -ge 13 ]; then
  check_node
fi

if [ "$phase" -ge 14 ]; then
  check_maestro
  check_booted_simulator
fi

if [ "$android" -eq 1 ]; then
  check_android
fi

exit "$missing"
