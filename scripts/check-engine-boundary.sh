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
# Usage: check-engine-boundary.sh [--max N] [--quiet]
#   --max N   exit 1 when the total exceeds N (default 0)
#   --quiet   print only the total line
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
src="src-tauri/src"

# Candidate set, relative to the repo root. Missing paths are skipped.
candidates=(
  "$src/db"
  "$src/utils"
  "$src/yjs_doc.rs"
  "$src/ops"
  "$src/sync"
  "$src/ai"
  "$src/import_apple_journal.rs"
  "$src/import_apple_journal_yjs.rs"
  "$src/import_html.rs"
  "$src/import_markdown.rs"
)

# Excluded from the candidate set: files, or directories when ending in "/".
excluded=(
  "$src/sync/scheduler.rs"
  "$src/ai/on_device/server.rs"
  "$src/ai/on_device/server_binary.rs"
  "$src/ai/on_device/llm_download.rs"
  "$src/ai/providers/cli/"
  "$src/ai/providers/on_device_llm.rs"
)

max="0"
quiet=0
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
    -h | --help) sed -n '2,17p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "error: unknown argument '$1'" >&2; exit 2 ;;
  esac
done

is_excluded() {
  local f="$1" e
  for e in "${excluded[@]}"; do
    case "$e" in
      */) case "$f" in "$e"*) return 0 ;; esac ;;
      *) [ "$f" = "$e" ] && return 0 ;;
    esac
  done
  return 1
}

cd "$root"
files=()
while IFS= read -r f; do
  is_excluded "$f" || files+=("$f")
done < <(
  for p in "${candidates[@]}"; do
    if [ -d "$p" ]; then
      find "$p" -type f -name '*.rs'
    elif [ -f "$p" ]; then
      echo "$p"
    fi
  done | sort -u
)

if [ "${#files[@]}" -eq 0 ]; then
  echo "error: no candidate files found under $root/$src" >&2
  exit 2
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
