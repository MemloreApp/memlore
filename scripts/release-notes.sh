#!/usr/bin/env bash
#
# scripts/release-notes.sh — print the release notes for one desktop version.
#
# Usage: scripts/release-notes.sh <version>     (e.g. 0.2.3 or v0.2.3)
#
# Prints the body of the `## v<version>` section of CHANGELOG.md (repo root),
# stopping at the next `## ` heading. When the section is missing or blank it
# prints `See the commit history for changes in v<version>.` instead, and notes
# the fallback on stderr. Shared by .github/workflows/release.yml and the local
# release script so both publish identical notes.

set -euo pipefail

if [ "$#" -ne 1 ] || [ -z "$1" ]; then
  echo "usage: $0 <version>" >&2
  exit 2
fi

VERSION="${1#v}"
CHANGELOG="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/CHANGELOG.md"

BODY=""
if [ -f "$CHANGELOG" ]; then
  # Matched with literal string comparison, not a regex. Escaping the
  # version for a regex does not work here: awk processes backslash
  # escapes in -v assignments, so a pre-escaped "1\.0\.0" arrives
  # back as "1.0.0" and the dots are wildcards again — which makes
  # "## v1a0a0" a match. Verified locally.
  BODY="$(awk -v v="$VERSION" '
    function is_version_heading(line, ver,   rest, nxt) {
      if (substr(line, 1, 3) != "## ") return 0
      rest = substr(line, 4)
      if (substr(rest, 1, 1) == "v") rest = substr(rest, 2)
      if (substr(rest, 1, length(ver)) != ver) return 0
      nxt = substr(rest, length(ver) + 1, 1)
      return (nxt == "" || nxt == " " || nxt == "(")
    }
    is_version_heading($0, v) { found = 1; next }
    found && substr($0, 1, 3) == "## " { exit }
    found { print }
  ' "$CHANGELOG")"
fi

if [ -z "$(printf '%s' "$BODY" | tr -d '[:space:]')" ]; then
  BODY="See the commit history for changes in v${VERSION}."
  echo "No CHANGELOG.md section for $VERSION — using a placeholder body." >&2
fi

printf '%s\n' "$BODY"
