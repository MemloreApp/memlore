#!/usr/bin/env bash
# Licence check for the mobile-app plan (Phase 2).
#   1. Rust: cargo-deny licence policy for the desktop/web workspace
#      (src-tauri/deny.toml).
#   2. JS: scripts/js-licenses.mjs against legal/js-license-allowlist.json.
# --mobile also runs the mobile Rust profile (src-tauri/deny.mobile.toml,
# rooted at memlore-mobile-ffi) and the JS check for mobile/ (Phase 13); until
# mobile/package.json exists js-licenses.mjs prints "not present yet".
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

# --config is explicit: cargo-deny defaults to <cwd>/deny.toml. The mobile FFI
# crate is excluded: its graph is checked by the --mobile profile only, so a
# mobile-only licence never blocks a desktop release.
cargo deny --manifest-path src-tauri/Cargo.toml --config src-tauri/deny.toml --workspace --exclude memlore-mobile-ffi check licenses

node scripts/js-licenses.mjs

if [ "$mobile" -eq 1 ]; then
  cargo deny --manifest-path src-tauri/crates/memlore-mobile-ffi/Cargo.toml --config src-tauri/deny.mobile.toml check licenses
  node scripts/js-licenses.mjs --dir mobile
fi
