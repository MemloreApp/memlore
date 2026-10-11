# _release-materials.sh — sourced helper, not run directly.
#
# Usage (from a script under this directory, after `set -euo pipefail`):
#   source "$(dirname "${BASH_SOURCE[0]}")/_release-materials.sh"
#   load_release_secrets APPLE_API_ISSUER APPLE_API_KEY ...           # required keys
#   load_release_secrets --optional CLOUDFLARE_API_TOKEN ...          # optional keys
#   load_release_secrets --optional OPT1 OPT2 -- REQ1 REQ2            # both
#
# Reads ${MEMLORE_RELEASE_SECRETS:-$REPO_ROOT/docs/release-secrets/release.secrets}
# as KEY=value lines and exports ONLY the keys the caller names, so a build
# never sees secrets meant for another step. Every named key must be in the
# allow-list below. The file is parsed, never `source`d or `eval`ed, and values
# are never printed: required keys print `ok:` / `missing:`, optional keys print
# `optional: NAME set|unset` (set = non-empty in the environment afterwards,
# whether from the file or the caller's shell). Setup: .github/release-setup.md.
#
# Parsing mirrors src-tauri/build.rs: blank lines and `#` comments are skipped,
# a line splits on its first `=`, key and value are trimmed, one layer of
# matching "..." or '...' quotes is stripped, and a value containing control
# characters is rejected. The last occurrence of a key wins. An empty or
# rejected value counts as missing and UNSETS the key, even if an earlier line
# set it: build.rs lets even an empty exported var override the dev .env file.
#
# Returns 1 when a required key is missing, a named key is not allow-listed, or
# the default path is not gitignored. Optional keys never fail. Never exits, so
# it is safe under the caller's `set -euo pipefail`.
# Written for bash 3.2 (macOS /bin/bash): no associative arrays.

_RELEASE_SECRETS_ALLOWED="APPLE_API_ISSUER APPLE_API_KEY GDRIVE_CLIENT_ID GDRIVE_CLIENT_SECRET GOOGLE_FONTS_API_KEY MEMLORE_MAPKIT_TOKEN CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID"

# Exact-token membership: _release_secrets_has NAME "A B C".
_release_secrets_has() {
  local item
  for item in $2; do
    if [[ "$1" == "$item" ]]; then
      return 0
    fi
  done
  return 1
}

load_release_secrets() {
  local file line key value mode name arg found="" missing=0
  local required="" optional="" in_optional=0

  for arg in "$@"; do
    case "$arg" in
      --optional) in_optional=1 ;;
      --) in_optional=0 ;;
      -*)
        echo "error: load_release_secrets: unknown option $arg" >&2
        return 1
        ;;
      *)
        if ! _release_secrets_has "$arg" "$_RELEASE_SECRETS_ALLOWED"; then
          echo "error: load_release_secrets: $arg is not an allow-listed release secret" >&2
          return 1
        fi
        if [[ $in_optional -eq 1 ]]; then
          optional="$optional $arg"
        else
          required="$required $arg"
        fi
        ;;
    esac
  done

  if [[ -z "${REPO_ROOT:-}" ]]; then
    if ! REPO_ROOT="$(git rev-parse --show-toplevel)"; then
      echo "error: REPO_ROOT is unset and this is not a git checkout" >&2
      return 1
    fi
  fi

  if [[ -n "${MEMLORE_RELEASE_SECRETS:-}" ]]; then
    file="$MEMLORE_RELEASE_SECRETS"
  else
    file="$REPO_ROOT/docs/release-secrets/release.secrets"
    # check-ignore matches patterns, so this holds even before the file exists.
    if ! git -C "$REPO_ROOT" check-ignore -q "$file"; then
      echo "error: $file is not gitignored; refusing to read secrets from it" >&2
      return 1
    fi
  fi

  if [[ ! -f "$file" ]]; then
    echo "warning: secrets file not found: $file" >&2
  else
    mode="$(stat -f %Lp "$file" 2>/dev/null || stat -c %a "$file" 2>/dev/null || true)"
    if [[ "$mode" != "600" ]]; then
      echo "warning: $file has mode ${mode:-unknown}, expected 600 (chmod 600 \"$file\")" >&2
    fi

    while IFS= read -r line || [[ -n "$line" ]]; do
      line="${line%$'\r'}" # CRLF line ending, as Rust's str::lines() drops it
      line="${line#"${line%%[![:space:]]*}"}"
      line="${line%"${line##*[![:space:]]}"}"
      if [[ -z "$line" || "$line" == \#* || "$line" != *=* ]]; then
        continue
      fi

      key="${line%%=*}"
      key="${key%"${key##*[![:space:]]}"}"
      # Unknown or malformed keys (e.g. "A B") never match a token exactly.
      if ! _release_secrets_has "$key" "$_RELEASE_SECRETS_ALLOWED"; then
        continue
      fi
      # Allow-listed but not asked for: never exported.
      if ! _release_secrets_has "$key" "$required $optional"; then
        continue
      fi

      value="${line#*=}"
      value="${value#"${value%%[![:space:]]*}"}"
      if [[ ${#value} -ge 2 && ("$value" == \"*\" || "$value" == \'*\') ]]; then
        value="${value:1:${#value}-2}"
      fi

      # Last occurrence of a key wins, including an empty or rejected one.
      found="${found// $key / }"
      if [[ "$value" == *[[:cntrl:]]* ]]; then
        echo "warning: ignoring $key: value contains control characters" >&2
        unset "$key"
        continue
      fi
      if [[ -z "$value" ]]; then
        unset "$key"
        continue
      fi

      # printf -v keeps the value off any command line (and out of `set -x`).
      printf -v "$key" '%s' "$value"
      export "$key"
      found="$found $key "
    done <"$file"
  fi

  for name in $required; do
    if [[ "$found" == *" $name "* ]]; then
      echo "ok: $name"
    else
      echo "missing: $name"
      missing=1
    fi
  done
  for name in $optional; do
    if [[ -n "${!name:-}" ]]; then
      echo "optional: $name set"
    else
      echo "optional: $name unset"
    fi
  done
  if [[ $missing -ne 0 ]]; then
    return 1
  fi
  return 0
}
