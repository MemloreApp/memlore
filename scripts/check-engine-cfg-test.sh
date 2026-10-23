#!/usr/bin/env bash
# Engine cfg(test) guard for the mobile-app plan (Phase 9.2).
# Once the engine is its own crate, glue tests compile it as a dependency, so
# `cfg(test)` is false inside it and every switch keyed on it would silently
# flip. Engine code must use `cfg(any(test, feature = "test-support"))` (and
# the `not(...)` / `cfg!` / `cfg_attr` forms) instead.
#
# Lists every `cfg(test)`, `cfg(not(test))`, `cfg!(test)` or `cfg_attr(test …)`
# style occurrence (any bare `test` predicate inside a cfg) in the engine
# candidate set whose next non-attribute, non-comment line is not
# `mod <name>` with <name> `tests` or ending in `_tests`. Inner attributes
# (`#![cfg(test)]`) are always reported. Comment lines (`//`, `///`, `//!`)
# are skipped.
#
# The candidate set comes from scripts/_engine_files.sh (same list as
# check-engine-boundary.sh). By default both `src-tauri/src` (before Phase 10)
# and `src-tauri/crates/memlore-engine/src` (after Phase 10) are scanned;
# missing roots are skipped.
#
# Usage: check-engine-cfg-test.sh [--src DIR]...
#   --src DIR   scan only DIR (relative to the repo root); repeatable
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/_engine_files.sh
source "$root/scripts/_engine_files.sh"

srcs=()
while [ $# -gt 0 ]; do
  case "$1" in
    --src)
      [ $# -ge 2 ] || { echo "error: --src needs a directory" >&2; exit 2; }
      srcs+=("$2")
      shift 2
      ;;
    -h | --help) sed -n '2,21p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "error: unknown argument '$1'" >&2; exit 2 ;;
  esac
done
if [ "${#srcs[@]}" -eq 0 ]; then
  srcs=("src-tauri/src" "src-tauri/crates/memlore-engine/src")
fi

cd "$root"
files=()
for s in "${srcs[@]}"; do
  while IFS= read -r f; do
    files+=("$f")
  done < <(engine_candidate_files "$s")
done

if [ "${#files[@]}" -eq 0 ]; then
  echo "error: no candidate files found under ${srcs[*]}" >&2
  exit 2
fi

hits="$(awk '
  function report(i) {
    for (i = 1; i <= n; i++) printf "%s\n", pending[i]
    n = 0
  }
  # Bare `test` predicate inside a cfg construct, ignoring the allowed form.
  function is_test_cfg(s) {
    gsub(/any\(test, feature = "test-support"\)/, "", s)
    return s ~ /cfg(_attr)?!?\(/ && s ~ /[(, ]test[),]/
  }
  function is_tests_mod(s) {
    return s ~ /^[ \t]*(pub(\([^)]*\))?[ \t]+)?mod[ \t]+([A-Za-z0-9_]*_)?tests[ \t]*[{;]/
  }
  FNR == 1 { report() }
  {
    line = $0
    if (line ~ /^[ \t]*\/\// || line ~ /^[ \t]*$/) next
    is_attr = (line ~ /^[ \t]*#!?\[/)
    if (is_attr && is_test_cfg(line)) {
      text = line
      sub(/^[ \t]+/, "", text)
      entry = sprintf("%s:%d: %s", FILENAME, FNR, text)
      if (line ~ /^[ \t]*#!\[/) { printf "%s\n", entry; next }
      # Same-line item after the attribute(s), e.g. `#[cfg(test)] mod tests {`.
      rest = line
      while (rest ~ /^[ \t]*#\[[^]]*\]/) sub(/^[ \t]*#\[[^]]*\]/, "", rest)
      if (rest ~ /^[ \t]*$/) { pending[++n] = entry; next }
      if (!is_tests_mod(rest)) printf "%s\n", entry
      next
    }
    if (is_attr) next
    if (!is_attr && is_test_cfg(line)) {
      # Expression form (`cfg!(test)`) on a code line.
      text = line
      sub(/^[ \t]+/, "", text)
      printf "%s:%d: %s\n", FILENAME, FNR, text
    }
    if (n > 0) {
      if (is_tests_mod(line)) n = 0
      else report()
    }
  }
  END { report() }
' "${files[@]}")"

if [ -n "$hits" ]; then
  total="$(printf '%s\n' "$hits" | wc -l | tr -d ' ')"
  printf '%s\n' "$hits"
else
  total=0
fi
echo "total: $total"

if [ "$total" -gt 0 ]; then
  echo "FAIL: use cfg(any(test, feature = \"test-support\")) outside mod tests / mod *_tests" >&2
  exit 1
fi
