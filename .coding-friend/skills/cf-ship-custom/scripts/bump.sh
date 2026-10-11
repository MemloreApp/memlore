#!/usr/bin/env bash
# bump.sh — set ONE platform's version across every file that carries it.
#
# Usage: bash bump.sh --mac|--web <new_version>
#   e.g. bash bump.sh --mac 0.2.0
#        bash bump.sh --web 0.1.1
#
# --mac (desktop app): FOUR files, not three. Forgetting Cargo.lock leaves
#   `cargo build --locked` and CI drifting against Cargo.toml.
# --web (web companion): ONE file, web/version.json. deploy-web.yml refuses a
#   web-v* tag that does not match it.
# Each platform's files are the only ones touched: a --web bump never changes the
# desktop version and vice versa.
#
# Stable X.Y.Z only. Prereleases are discontinued, so any `-` suffix is refused.
# The tag and tauri.conf.json must agree exactly — release.yml refuses to build
# when they do not.

set -euo pipefail

# scripts -> cf-ship-custom -> skills -> .coding-friend -> repo root = four levels.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
PLATFORM="${1:-}"
NEW_VERSION="${2:-}"

if [[ "$PLATFORM" != "--mac" && "$PLATFORM" != "--web" ]] || [[ -z "$NEW_VERSION" ]]; then
  echo "Usage: bash bump.sh --mac|--web <new_version>    e.g. --mac 0.2.0, --web 0.1.1"
  exit 1
fi
PLATFORM="${PLATFORM#--}"

# Core semver only. Checked before anything is written, so a refused version
# leaves every file untouched.
if [[ "$NEW_VERSION" == *-* ]]; then
  echo "Error: '$NEW_VERSION' has a prerelease suffix. Prereleases are discontinued;"
  echo "ship a stable version (X.Y.Z)."
  exit 1
fi
if ! [[ "$NEW_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Error: version must be X.Y.Z (got '$NEW_VERSION')"
  exit 1
fi

cd "$REPO_ROOT"

# Guard the path arithmetic above rather than letting a wrong REPO_ROOT surface
# as a bare FileNotFoundError from python three functions later.
for required in package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml web/version.json; do
  if [[ ! -f "$required" ]]; then
    echo "Error: $required not found under REPO_ROOT=$REPO_ROOT"
    echo "The relative path from this script to the repository root is wrong."
    exit 1
  fi
done

# ─── JSON: package.json, src-tauri/tauri.conf.json ────────────────────────────
#
# Edited with python's json module rather than sed so a stray "version" key
# elsewhere in the file cannot be hit by accident. Both files are prettier-
# formatted with 2-space indent and a trailing newline; this preserves that.

bump_json() {
  local file="$1"
  python3 - "$file" "$NEW_VERSION" <<'PY'
import collections, json, sys
path, version = sys.argv[1], sys.argv[2]
with open(path) as f:
    data = json.load(f, object_pairs_hook=collections.OrderedDict)
old = data.get("version")
data["version"] = version
with open(path, "w") as f:
    json.dump(data, f, indent=2, ensure_ascii=False)
    f.write("\n")
print(f"  {path}: {old} -> {version}")
PY
}

# ─── TOML: src-tauri/Cargo.toml ───────────────────────────────────────────────
#
# Only the `version` under [package] — never a dependency's version. The range
# is bounded by the next section header so `tauri = { version = "2" }` further
# down is untouched.

bump_cargo_toml() {
  local file="src-tauri/Cargo.toml"
  python3 - "$file" "$NEW_VERSION" <<'PY'
import re, sys
path, version = sys.argv[1], sys.argv[2]
src = open(path).read()

start = src.index("[package]")
end = src.find("\n[", start + 1)
if end == -1:
    end = len(src)
head, body, tail = src[:start], src[start:end], src[end:]

new_body, n = re.subn(
    r'(?m)^version\s*=\s*"[^"]*"', f'version = "{version}"', body, count=1
)
if n != 1:
    sys.exit(f"Error: no version line found in [package] of {path}")

open(path, "w").write(head + new_body + tail)
print(f"  {path}: -> {version}")
PY
}

# ─── --web: web/version.json only ────────────────────────────────────────────

if [[ "$PLATFORM" == "web" ]]; then
  echo "Bumping the Memlore web companion to ${NEW_VERSION}…"
  bump_json "web/version.json"
  pnpm exec prettier --write web/version.json > /dev/null 2>&1 \
    || echo "  WARNING: prettier did not run on web/version.json — check 'git diff'."
  ACTUAL="$(python3 -c 'import json;print(json.load(open("web/version.json"))["version"])')"
  if [[ "$ACTUAL" != "$NEW_VERSION" ]]; then
    echo "  FAIL  web/version.json = $ACTUAL (expected $NEW_VERSION)"
    exit 1
  fi
  echo "  ok    web/version.json = $ACTUAL"
  echo ""
  echo "Done. Next: update CHANGELOG.md and changelogData.ts (platform 'web'), commit,"
  echo "then tag web-v$NEW_VERSION."
  exit 0
fi

# ─── --mac: the desktop app's four files ─────────────────────────────────────

echo "Bumping the Memlore desktop app to ${NEW_VERSION}…"
bump_json "package.json"
bump_json "src-tauri/tauri.conf.json"
bump_cargo_toml

# ─── Cargo.lock ───────────────────────────────────────────────────────────────
#
# `cargo update -p memlore` rewrites only this package's own entry. It needs
# Cargo.toml already bumped, which is why it runs last.

# json.dump(indent=2) expands short arrays that prettier keeps on one line, so
# the JSON files come back reformatted beyond the version bump. Hand them back
# to prettier rather than leaving unrelated churn in the release commit.
if pnpm exec prettier --write package.json src-tauri/tauri.conf.json > /dev/null 2>&1; then
  echo "  (re-formatted both JSON files with prettier)"
else
  echo "  WARNING: prettier did not run. package.json and tauri.conf.json may"
  echo "  carry formatting churn — check 'git diff' before committing."
fi

echo "  src-tauri/Cargo.lock:"
cargo update -p memlore --manifest-path src-tauri/Cargo.toml 2>&1 | sed 's/^/    /'

# ─── Verify all four agree ────────────────────────────────────────────────────
#
# A silent partial bump is the failure mode worth guarding: release.yml checks
# the tag against tauri.conf.json only, so a stale Cargo.toml would sail past CI
# and ship a binary reporting the wrong version to the updater.

echo ""
echo "Verifying:"
FAILED=0
check() {
  local label="$1" actual="$2"
  if [[ "$actual" == "$NEW_VERSION" ]]; then
    echo "  ok    $label = $actual"
  else
    echo "  FAIL  $label = $actual (expected $NEW_VERSION)"
    FAILED=1
  fi
}

check "package.json" \
  "$(python3 -c 'import json;print(json.load(open("package.json"))["version"])')"
check "tauri.conf.json" \
  "$(python3 -c 'import json;print(json.load(open("src-tauri/tauri.conf.json"))["version"])')"
check "Cargo.toml" \
  "$(python3 -c '
import re
src = open("src-tauri/Cargo.toml").read()
pkg = src[src.index("[package]"):]
end = pkg.find("\n[", 1)
print(re.search(r"(?m)^version\s*=\s*\"([^\"]*)\"", pkg[:end if end != -1 else None]).group(1))
')"
check "Cargo.lock" \
  "$(python3 -c '
import re
src = open("src-tauri/Cargo.lock").read()
m = re.search(r"(?ms)^\[\[package\]\]\nname = \"memlore\"\nversion = \"([^\"]*)\"", src)
print(m.group(1) if m else "NOT FOUND")
')"

if [[ "$FAILED" -ne 0 ]]; then
  echo ""
  echo "One or more files did not take the new version. Nothing was reverted —"
  echo "inspect with: git diff"
  exit 1
fi

echo ""
echo "Done. Next: update CHANGELOG.md and changelogData.ts (platform 'mac'), commit,"
echo "then tag v$NEW_VERSION."
