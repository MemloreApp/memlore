# Engine candidate file list, shared by check-engine-boundary.sh and
# check-engine-cfg-test.sh (mobile-app plan, phases 5, 9 and 10).
# shellcheck shell=bash

engine_crate_src="src-tauri/crates/memlore-engine/src"

# engine_src
#   Prints the engine source root, relative to the repo root (call it from
#   there): the engine crate once the cluster has moved (Phase 10.2, detected
#   by `$engine_crate_src/db`), else the desktop crate `src-tauri/src`.
engine_src() {
  if [ -d "$engine_crate_src/db" ]; then
    echo "$engine_crate_src"
  else
    echo "src-tauri/src"
  fi
}

# engine_candidate_files <src>
#   Prints, one per line and sorted, every `.rs` file of the engine candidate
#   set under <src>. When <src> is the engine crate (path ending in
#   `crates/memlore-engine/src`), that is every `.rs` file under it: the
#   desktop-only files stay in src-tauri. Otherwise it is the candidate list
#   below minus the exclusions.
#   Returns 2, printing nothing, when a path in the list does not exist, so a
#   caller can never pass vacuously. Call it as `out="$(…)" || exit 2`: an
#   exit status read through `< <(…)` is lost.
engine_candidate_files() {
  local src="$1" p f e skip engine=0
  case "$src" in
    crates/memlore-engine/src | */crates/memlore-engine/src) engine=1 ;;
  esac

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

  # Excluded from the candidate set (desktop crate only): files, or
  # directories when ending in "/".
  local excluded=(
    "$src/sync/scheduler.rs"
    "$src/ai/on_device/server.rs"
    "$src/ai/on_device/server_binary.rs"
    "$src/ai/on_device/llm_download.rs"
    "$src/ai/providers/cli/"
    "$src/ai/providers/on_device_llm.rs"
  )

  local required=("${candidates[@]}")
  [ "$engine" -eq 1 ] || required+=("${excluded[@]}")
  for p in "${required[@]}"; do
    if [ ! -e "$p" ]; then
      echo "error: engine candidate path missing: $p" >&2
      return 2
    fi
  done

  if [ "$engine" -eq 1 ]; then
    find "$src" -type f -name '*.rs' | sort -u
    return 0
  fi

  for p in "${candidates[@]}"; do
    if [ -d "$p" ]; then
      find "$p" -type f -name '*.rs'
    else
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
