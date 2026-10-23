#!/usr/bin/env bash
# Engine boundary guard for the mobile-app plan (Phase 5.1).
# Counts references from the engine candidate set (code that will move out of
# the Tauri crate) into desktop-only code: commands, MCP, the reminder and sync
# schedulers, test_support, macos, Tauri itself and build-time env macros.
# Phases 5 to 8 drove the total to 0; since Phase 8.5 the default limit is 0.
#
# A hit is one source line. Comment lines (`//`, `///`, `//!` after leading
# whitespace) are skipped; trailing comments and string literals still count.
# Besides the fixed patterns, lines inside a `use crate::{ … }` block (single-
# or multi-line) that name `commands`, `mcp`, `test_support`, `macos`,
# `reminders::scheduler` or `sync::scheduler` count too, since
# `crate::commands` never appears literally there.
#
# Usage: check-engine-boundary.sh [--max N] [--quiet] [--graph]
#   --max N   exit 1 when the total exceeds N (default 0)
#   --quiet   print only the total line
#   --graph   instead, print `uniq -c` of every `crate::<root>` on non-comment
#             lines (Phase 9.3 move-entry check); exit 1 if a root outside
#             db utils sync ai ops yjs_doc import_* AppState
#             EncryptionKeyState ContentKeyList appears, or any `crate::{`
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
src="src-tauri/src"

# Candidate file list (shared with check-engine-cfg-test.sh).
# shellcheck source=scripts/_engine_files.sh
source "$root/scripts/_engine_files.sh"

max="0"
quiet=0
graph=0
while [ $# -gt 0 ]; do
  case "$1" in
    --max)
      [ $# -ge 2 ] || { echo "error: --max needs a number" >&2; exit 2; }
      case "$2" in
        '' | *[!0-9]*) echo "error: --max needs a number, got '$2'" >&2; exit 2 ;;
      esac
      max="$2"
      shift 2
      ;;
    --quiet) quiet=1; shift ;;
    --graph) graph=1; shift ;;
    -h | --help) sed -n '2,21p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "error: unknown argument '$1'" >&2; exit 2 ;;
  esac
done

cd "$root"
files=()
while IFS= read -r f; do
  files+=("$f")
done < <(engine_candidate_files "$src")

if [ "${#files[@]}" -eq 0 ]; then
  echo "error: no candidate files found under $root/$src" >&2
  exit 2
fi

if [ "$graph" -eq 1 ]; then
  # Non-comment lines only (`//`, `///`, `//!` after leading whitespace).
  code="$(awk '!/^[ \t]*\/\//' "${files[@]}")"
  printf '%s\n' "$code" | { grep -oE 'crate::[A-Za-z_]+' || true; } | sort | uniq -c
  bad="$(printf '%s\n' "$code" | { grep -oE 'crate::[A-Za-z_]+' || true; } |
    sed 's/^crate:://' | sort -u |
    { grep -vxE '(db|utils|sync|ai|ops|yjs_doc|import_[A-Za-z_]+|AppState|EncryptionKeyState|ContentKeyList)' || true; })"
  grouped="$(printf '%s\n' "$code" | { grep -c 'crate::{' || true; })"
  status=0
  if [ -n "$bad" ]; then
    echo "FAIL: out-of-cluster crate:: roots: $(printf '%s\n' "$bad" | tr '\n' ' ')" >&2
    status=1
  fi
  if [ "$grouped" -ne 0 ]; then
    echo "FAIL: $grouped grouped \`crate::{\` import line(s); expand them so the graph sees every root" >&2
    status=1
  fi
  exit "$status"
fi

hits="$(awk '
  FNR == 1 { in_use = 0 }
  {
    line = $0
    is_comment = (line ~ /^[ \t]*\/\//)
    hit = 0
    if (!is_comment) {
      if (line ~ /crate::(commands|mcp|reminders::scheduler|sync::scheduler|test_support|macos)/ ||
          line ~ /tauri::/ || line ~ /AppHandle/ || line ~ /option_env!/ ||
          line ~ /env!\("CARGO_PKG_VERSION"\)/) {
        hit = 1
      }
      # Grouped scheduler imports and relative paths into glue modules.
      if (line ~ /crate::(sync|reminders)::\{[^}]*(^|[^A-Za-z0-9_])scheduler([^A-Za-z0-9_]|$)/ ||
          line ~ /super::(super::)*(commands|mcp|macos)([^A-Za-z0-9_]|$)/) {
        hit = 1
      }
      if (line ~ /use crate::\{/) { in_use = 1 }
      if (in_use && line ~ /(^|[^A-Za-z0-9_])(commands|mcp|test_support|macos|reminders::scheduler|sync::scheduler)([^A-Za-z0-9_]|$)/) {
        hit = 1
      }
    }
    if (hit) {
      text = line
      sub(/^[ \t]+/, "", text)
      printf "%s:%d: %s\n", FILENAME, FNR, text
    }
    if (in_use && !is_comment && line ~ /\};/) { in_use = 0 }
  }
' "${files[@]}")"

if [ -n "$hits" ]; then
  total="$(printf '%s\n' "$hits" | wc -l | tr -d ' ')"
else
  total=0
fi

if [ "$quiet" -eq 0 ] && [ -n "$hits" ]; then
  printf '%s\n' "$hits"
fi
echo "total: $total"

if [ -n "$max" ] && [ "$total" -gt "$max" ]; then
  echo "FAIL: engine boundary total $total exceeds --max $max" >&2
  exit 1
fi
