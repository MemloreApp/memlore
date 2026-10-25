#!/usr/bin/env bash
# Check that .easignore (repo root) and mobile/.easignore keep sensitive paths
# out of an EAS Build upload. Usage: bash scripts/easignore-check.sh
# For each file, the upload is approximated with git's gitignore-compatible
# matcher, run from the directory EAS would archive:
#   untracked: git ls-files -o --exclude-from=<file>
#   tracked:   git ls-files -c minus git ls-files -ci --exclude-from=<file>
# The authoritative check (eas build:inspect + searching the archive) needs an
# EAS login and runs in roadmap M9.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
sensitive='(^|/)docs/|\.p8$|\.p12$|\.key$|\.pem$|\.jks$|\.provisionprofile$|\.mobileprovision$|client_secret|google_cloud_.*\.json|passphrase|release-secrets/|(^|/)\.env'
status=0

check() {
  local dir="$1" ignore_file="$2" kept leaked
  [ -f "$dir/$ignore_file" ] || { echo "easignore-check: $dir/$ignore_file is missing" >&2; return 1; }
  kept="$(
    cd "$dir"
    {
      git ls-files -o --exclude-from="$ignore_file"
      comm -23 <(git ls-files -c | sort -u) <(git ls-files -ci --exclude-from="$ignore_file" | sort -u)
    } | sort -u
  )"
  # An empty list means git failed, not that nothing would be uploaded.
  [ -n "$kept" ] || { echo "easignore-check: no files listed for $dir/$ignore_file" >&2; return 1; }
  leaked="$(grep -E "$sensitive" <<<"$kept" || true)"
  if [ -n "$leaked" ]; then
    echo "easignore-check: $dir/$ignore_file lets sensitive paths through:" >&2
    echo "$leaked" >&2
    return 1
  fi
  echo "easignore-check: $dir/$ignore_file ok ($(grep -c . <<<"$kept") files kept)"
}

check "$root" .easignore || status=1
check "$root/mobile" .easignore || status=1
exit "$status"
