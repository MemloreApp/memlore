#!/usr/bin/env bash
# Licence check for the mobile-app plan (Phase 2).
#   1. Rust: cargo-deny licence policy for the desktop/web workspace
#      (src-tauri/deny.toml).
#   2. JS: scripts/js-licenses.mjs against legal/js-license-allowlist.json.
# --mobile also runs the mobile Rust profile (src-tauri/deny.mobile.toml,
# created in Phase 12) and the JS check for mobile/ (Phase 13); until they
# exist each prints "not yet".
# Exits non-zero on the first failing check.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

mobile=0
for arg in "$@"; do
  case "$arg" in
    --mobile) mobile=1 ;;
    *)
      echo "usage: $0 [--mobile]" >&2
      exit 2
      ;;
  esac
done

# --config is explicit: cargo-deny defaults to <cwd>/deny.toml.
cargo deny --manifest-path src-tauri/Cargo.toml --config src-tauri/deny.toml --workspace check licenses

node scripts/js-licenses.mjs

if [ "$mobile" -eq 1 ]; then
  if [ ! -f src-tauri/deny.mobile.toml ]; then
    echo "mobile licence profile: not yet (Phase 12)"
  else
    cargo deny --manifest-path src-tauri/crates/memlore-mobile-ffi/Cargo.toml --config src-tauri/deny.mobile.toml check licenses
  fi
  node scripts/js-licenses.mjs --dir mobile
fi
