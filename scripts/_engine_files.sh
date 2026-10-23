# Engine candidate file list, shared by check-engine-boundary.sh and
# check-engine-cfg-test.sh (mobile-app plan, phases 5 and 9).
# shellcheck shell=bash

# engine_candidate_files <src>
#   Prints, one per line and sorted, every `.rs` file of the engine candidate
#   set under <src> (a path relative to the current directory, e.g.
#   `src-tauri/src`; after Phase 10, `src-tauri/crates/memlore-engine/src`).
#   Missing candidate or excluded paths are skipped.
engine_candidate_files() {
  local src="$1" p f e skip

  # Candidate set, relative to <src>.
  local candidates=(
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
  local excluded=(
    "$src/sync/scheduler.rs"
    "$src/ai/on_device/server.rs"
    "$src/ai/on_device/server_binary.rs"
    "$src/ai/on_device/llm_download.rs"
    "$src/ai/providers/cli/"
    "$src/ai/providers/on_device_llm.rs"
  )

  for p in "${candidates[@]}"; do
    if [ -d "$p" ]; then
      find "$p" -type f -name '*.rs'
    elif [ -f "$p" ]; then
      echo "$p"
    fi
  done | sort -u | while IFS= read -r f; do
    skip=0
    for e in "${excluded[@]}"; do
      case "$e" in
        */) case "$f" in "$e"*) skip=1 ;; esac ;;
        *) [ "$f" = "$e" ] && skip=1 ;;
      esac
    done
    [ "$skip" -eq 1 ] || echo "$f"
  done
}
