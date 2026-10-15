#!/usr/bin/env bash
# deploy-web-local.sh — build and deploy the web companion (web.memlore.app)
# from this Mac, instead of the GitHub Actions runner.
#
# Usage (from the repo root, HEAD detached at the tag, clean tree):
#   bash .coding-friend/skills/cf-ship-custom/scripts/deploy-web-local.sh <web-vX.Y.Z>
#   bash .coding-friend/skills/cf-ship-custom/scripts/deploy-web-local.sh --print-worker-status <web-vX.Y.Z>
#   e.g. ... deploy-web-local.sh web-v0.2.1
#
#   --print-worker-status  Only print whether workers/web-auth changed since
#                          the previous web-v* tag ("changed" / "unchanged").
#                          Deploys nothing.
#
# This is the default web deploy path. `/cf-ship --cloud` dispatches
# .github/workflows/deploy-web.yml instead.
#
# This script runs NO tests. `/cf-ship` B5 (`pnpm web:test`,
# `cargo test golden_`) is the only gate; run it before calling this.
#
# Production only: Pages deploys to the `main` branch. Only stable
# `web-vX.Y.Z` tags are accepted; web prereleases (the Pages `preview` branch)
# are discontinued.
#
# After the deploy it publishes a GitHub Release for the tag, its notes taken
# from the `## web-v<version>` section of CHANGELOG.md. Always `--latest=false`:
# `/releases/latest` must stay on the desktop release (stable updater, website
# download, stats worker). It is skipped until the latest desktop release is
# MIN_DESKTOP_FOR_WEB_RELEASES or newer, the first build whose beta channel
# skips non-`v*` releases; see web_release_blocked_reason.
#
# The auth Worker (workers/web-auth) is deployed only when it changed since the
# previous web-v* tag, or when there is none (first web release), same rule as
# deploy-web.yml: every Worker deploy re-applies wrangler.toml, including
# WEB_WRITES_ENABLED.
#
# Dependencies: `pnpm install --frozen-lockfile` runs before the build, so
# node_modules match the tag's pnpm-lock.yaml, not whatever was installed here.
#
# Cloudflare auth: either `pnpm exec wrangler login` once, or set
# CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID in
# docs/release-secrets/release.secrets (optional keys, read by
# _release-materials.sh, never printed). They are loaded only after
# `pnpm web:build`, for the deploy steps: the build runs with no release
# secrets, as in deploy-web.yml. Setup: .github/release-setup.md.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_PATH="$SCRIPT_DIR/$(basename "${BASH_SOURCE[0]}")"

die() {
  echo "Error: $*" >&2
  exit 1
}

step() {
  echo ""
  echo "==> $*"
}

usage() {
  echo "Usage: bash $SCRIPT_PATH <web-vX.Y.Z>" >&2
  echo "       bash $SCRIPT_PATH --print-worker-status <web-vX.Y.Z>" >&2
  exit 2
}

# ─── Worker status ────────────────────────────────────────────────────────────
#
# Same rule as deploy-web.yml: the previous web tag reachable from the tag's
# parent; none means the first web release, which deploys the Worker too.
# Prints "changed: <reason>" or "unchanged since <prev>".

prev_web_tag() {
  git -C "$REPO_ROOT" describe --tags --abbrev=0 --match 'web-v*' "$1^" 2>/dev/null || true
}

worker_status() {
  local tag="$1" prev
  prev="$(prev_web_tag "$tag")"
  if [[ -z "$prev" ]]; then
    echo "changed: no earlier web-v* tag (first web release)"
  elif ! git -C "$REPO_ROOT" diff --quiet "$prev" "$tag" -- workers/web-auth; then
    echo "changed: workers/web-auth differs from $prev"
  else
    echo "unchanged since $prev"
  fi
}

# Desktop builds up to v0.2.5 resolve the beta channel from the single newest
# release and reject a web-v* tag there, so a web release on top stalls their
# update check. Do not publish one until a fixed build is the stable release.
MIN_DESKTOP_FOR_WEB_RELEASES="v0.2.6"

# Prints why a web GitHub Release must not be published yet, or nothing.
web_release_blocked_reason() {
  local latest
  latest="$(gh release view --json tagName --jq .tagName 2>/dev/null)" \
    || { echo "could not read the latest desktop release"; return; }
  if [[ "$(printf '%s\n%s\n' "$MIN_DESKTOP_FOR_WEB_RELEASES" "$latest" | sort -V | head -1)" != "$MIN_DESKTOP_FOR_WEB_RELEASES" ]]; then
    echo "latest desktop release is $latest, older than $MIN_DESKTOP_FOR_WEB_RELEASES"
  fi
}

check_tag() {
  [[ "$1" =~ ^web-v[0-9]+\.[0-9]+\.[0-9]+$ ]] \
    || die "tag must be web-vX.Y.Z (got '$1'); web prereleases are discontinued"
  git -C "$REPO_ROOT" rev-parse -q --verify "refs/tags/$1^{commit}" >/dev/null \
    || die "tag $1 does not exist locally"
}

main() {
  local arg tag="" print_worker=0

  # ─── Arguments ──────────────────────────────────────────────────────────────

  for arg in "$@"; do
    case "$arg" in
      --print-worker-status) print_worker=1 ;;
      -*) usage ;;
      *)
        [[ -z "$tag" ]] || usage
        tag="$arg"
        ;;
    esac
  done
  [[ -n "$tag" ]] || usage

  # ─── Paths ──────────────────────────────────────────────────────────────────

  REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || die "run this from inside the memlore repository"
  [[ -f "$REPO_ROOT/web/version.json" ]] || die "web/version.json not found under REPO_ROOT=$REPO_ROOT"
  local version="${tag#web-v}"

  if [[ $print_worker -eq 1 ]]; then
    check_tag "$tag"
    echo "Worker $(worker_status "$tag")"
    return 0
  fi

  # shellcheck source=_release-materials.sh
  source "$SCRIPT_DIR/_release-materials.sh"

  # ─── Preflight ──────────────────────────────────────────────────────────────

  step "Preflight"
  check_tag "$tag"

  local cmd
  for cmd in git gh pnpm python3; do
    command -v "$cmd" >/dev/null 2>&1 || die "$cmd not found on PATH"
  done

  local tag_commit local_tag_obj remote_tag_obj
  tag_commit="$(git -C "$REPO_ROOT" rev-parse "refs/tags/$tag^{commit}")"
  local_tag_obj="$(git -C "$REPO_ROOT" rev-parse "refs/tags/$tag")"
  remote_tag_obj="$(git -C "$REPO_ROOT" ls-remote --exit-code --tags origin "refs/tags/$tag" | awk '{print $1; exit}')" \
    || die "tag $tag is not on origin (git push origin $tag)"
  [[ "$remote_tag_obj" == "$local_tag_obj" ]] || die "tag $tag on origin differs from the local tag"
  [[ "$(git -C "$REPO_ROOT" rev-parse HEAD)" == "$tag_commit" ]] \
    || die "HEAD is not $tag's commit (git checkout --detach $tag)"
  [[ -z "$(git -C "$REPO_ROOT" status --porcelain)" ]] \
    || die "working tree is not clean (git status)"

  # status --porcelain ignores gitignored paths, so it cannot see node_modules.
  (cd "$REPO_ROOT" && pnpm install --frozen-lockfile) \
    || die "pnpm install --frozen-lockfile failed (pnpm-lock.yaml out of date?)"
  [[ -z "$(git -C "$REPO_ROOT" status --porcelain)" ]] \
    || die "pnpm install changed the working tree (git status)"

  local file_version
  file_version="$(python3 -I -c 'import json, sys; print(json.load(open(sys.argv[1]))["version"])' \
    "$REPO_ROOT/web/version.json")"
  [[ "$file_version" == "$version" ]] \
    || die "web/version.json version is $file_version, tag is $tag"

  python3 -I -c 'import json, sys; sys.exit(0 if "web-auth:deploy" in json.load(open(sys.argv[1])).get("scripts", {}) else 1)' \
    "$REPO_ROOT/package.json" || die "package.json has no web-auth:deploy script"
  echo "ok: $tag at $tag_commit, clean tree, version $version"

  # ─── Build ──────────────────────────────────────────────────────────────────
  #
  # No release secrets are loaded yet: the web build needs none.

  step "Build"
  (cd "$REPO_ROOT" && pnpm web:build)

  # ─── Cloudflare auth ────────────────────────────────────────────────────────
  #
  # Loaded only now, for the deploy steps below. Optional keys only: a missing
  # secrets file is fine when `wrangler login` was done. `whoami --json` exits
  # non-zero when not authenticated (plain whoami does not; per the --help of
  # wrangler 4.133.0); its output (account details) is discarded.

  step "Cloudflare auth"
  load_release_secrets --optional CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID \
    || die "could not read release secrets (see .github/release-setup.md)"
  (cd "$REPO_ROOT" && pnpm exec wrangler whoami --json >/dev/null 2>&1) \
    || die "wrangler is not authenticated: run \`pnpm exec wrangler login\` or set CLOUDFLARE_API_TOKEN/CLOUDFLARE_ACCOUNT_ID in docs/release-secrets/release.secrets"
  echo "ok: wrangler authenticated"

  # ─── Deploy Pages ───────────────────────────────────────────────────────────

  step "Deploy Pages (production)"
  (cd "$REPO_ROOT" && pnpm exec wrangler pages deploy web/dist --project-name memlore-web \
    --branch main --commit-message "$tag")

  # ─── Deploy Worker ──────────────────────────────────────────────────────────

  step "Worker"
  local status
  status="$(worker_status "$tag")"
  if [[ "$status" == changed* ]]; then
    echo "Worker $status — deploying"
    (cd "$REPO_ROOT" && pnpm web-auth:deploy)
  else
    echo "Worker $status — not deployed"
  fi

  # ─── GitHub Release ─────────────────────────────────────────────────────────
  #
  # Never --latest: see the header. A re-run after a later failure finds the
  # release already there and leaves it alone.

  step "GitHub Release"
  local blocked
  blocked="$(web_release_blocked_reason)"
  if [[ -n "$blocked" ]]; then
    echo "Release skipped: $blocked. Once it is not, publish it with:"
    echo "  bash scripts/release-notes.sh $tag | gh release create $tag --verify-tag --latest=false --title \"Memlore Web $version\" --notes-file -"
  elif gh release view "$tag" >/dev/null 2>&1; then
    echo "Release $tag already exists — left as is"
  else
    bash "$REPO_ROOT/scripts/release-notes.sh" "$tag" \
      | gh release create "$tag" --verify-tag --latest=false \
        --title "Memlore Web $version" --notes-file -
    echo "ok: https://github.com/MemloreApp/memlore/releases/tag/$tag"
  fi

  echo ""
  echo "Deployed $tag."
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
