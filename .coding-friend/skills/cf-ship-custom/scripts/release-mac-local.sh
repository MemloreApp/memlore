#!/usr/bin/env bash
# release-mac-local.sh — build, sign, notarize and publish a desktop release
# from this Mac, instead of the GitHub Actions runner.
#
# Usage (from the repo root, HEAD detached at the tag, clean tree):
#   bash .coding-friend/skills/cf-ship-custom/scripts/release-mac-local.sh <tag> [--dry-run] [--resume]
#   e.g. ... release-mac-local.sh v0.2.4
#
#   --dry-run  Build, sign, notarize and verify, write the 4 release assets to a
#              scratch dir, but touch no GitHub Release. The build still submits
#              one REAL notarization to Apple.
#   --resume   A previous run died after creating the draft release: delete that
#              draft (never the tag; drafts are invisible to clients) and redo
#              the build and upload.
#
# This is the default desktop release path. `/cf-ship --cloud` dispatches
# .github/workflows/release.yml instead. Only stable `vX.Y.Z` tags are accepted;
# prereleases are discontinued.
#
# Dependencies: `pnpm install --frozen-lockfile` runs in preflight, so the
# frontend built by `pnpm tauri build` uses the tag's pnpm-lock.yaml.
#
# Release secrets: only the six keys below are exported to the build; the
# Cloudflare keys in the same file are not.
#
# Local materials (never committed, never printed):
#   docs/release-secrets/release.secrets  KEY=value lines, mode 600, read by
#     _release-materials.sh: APPLE_API_ISSUER, APPLE_API_KEY (the key id),
#     GDRIVE_CLIENT_ID, GDRIVE_CLIENT_SECRET, GOOGLE_FONTS_API_KEY,
#     MEMLORE_MAPKIT_TOKEN (the release values; they override the dev .env file).
#     MEMLORE_RELEASE_SECRETS=<path> points the loader at another file.
#   docs/release-secrets/AuthKey.p8       App Store Connect API key (notarization).
#   .ci/memlore.provisionprofile          Developer ID profile embedded by
#     tauri.conf.json. Required; this script only reads it.
#   ~/.tauri/memlore.key(.password)       Updater (minisign) signing key.
#   ~/.tauri/memlore.key.pub              Its public key; must equal
#     plugins.updater.pubkey in tauri.conf.json, and the built .sig is checked
#     against it before any upload.
#   Login keychain                        "Developer ID Application" identity of
#     the profile's team.
# Setup: .github/release-setup.md.
#
# First run: codesign asks to use the login-keychain key; click "Always Allow"
# once. The first local universal release build is cold (release profile and the
# x86_64 half were never built here); later releases reuse the cache.

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
  echo "Usage: bash $SCRIPT_PATH <vX.Y.Z> [--dry-run] [--resume]" >&2
  exit 2
}

# ─── latest.json ──────────────────────────────────────────────────────────────
#
# Same shape as tauri-action's (checked against v0.2.3's published file): every
# platform key points at the one universal .app.tar.gz. Notes and signature are
# passed as files, never on a command line.

write_latest_json() {
  local out="$1" version="$2" notes_file="$3" sig_file="$4" url="$5"
  python3 -I - "$out" "$version" "$notes_file" "$sig_file" "$url" <<'PY'
import json, sys
from datetime import datetime, timezone
out, version, notes_file, sig_file, url = sys.argv[1:]
with open(notes_file) as f:
    notes = f.read().strip()  # tauri-action trims; v0.2.3's notes match this
with open(sig_file) as f:
    signature = f.read().strip()
entry = {"signature": signature, "url": url}
keys = ["darwin-aarch64", "darwin-x86_64", "darwin-universal",
        "darwin-aarch64-app", "darwin-x86_64-app", "darwin-universal-app"]
data = {
    "version": version,
    "notes": notes,
    "pub_date": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "platforms": {k: dict(entry) for k in keys},
}
with open(out, "w") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
PY
}

assert_latest_json() {
  python3 -I - "$1" <<'PY'
import json, sys
with open(sys.argv[1]) as f:
    platforms = json.load(f)["platforms"]
expected = {"darwin-aarch64", "darwin-x86_64", "darwin-universal",
            "darwin-aarch64-app", "darwin-x86_64-app", "darwin-universal-app"}
if set(platforms) != expected:
    sys.exit("latest.json platforms are %s, expected %s" % (sorted(platforms), sorted(expected)))
for key, entry in platforms.items():
    if not entry.get("signature") or not entry.get("url"):
        sys.exit("latest.json %s has an empty signature or url" % key)
PY
}

# ─── Updater signature ────────────────────────────────────────────────────────
#
# Tauri wraps both the public key (tauri.conf.json) and the .sig in one more
# layer of base64 around the minisign text ("untrusted comment: ..." + a base64
# payload line). With minisign installed, the signature is fully verified.
# Without it, the key id is compared: bytes 2..10 of the payload, in both the
# public key ("Ed" + id + key) and the signature ("Ed"/"ED" + id + sig).

updater_sig_tool() {
  python3 -I - "$@" <<'PY'
import base64, sys

def minisign_text(wrapped):
    text = base64.b64decode("".join(wrapped.split()), validate=True).decode()
    lines = [l for l in text.splitlines() if l.strip()]
    if len(lines) < 2 or not lines[0].startswith("untrusted comment:"):
        sys.exit("not a minisign file")
    return text, base64.b64decode(lines[1], validate=True)

mode, pubkey, sig_file = sys.argv[1:4]
pub_text, pub = minisign_text(pubkey)
with open(sig_file) as f:
    sig_text, sig = minisign_text(f.read())
if len(pub) != 42 or pub[:2] != b"Ed":
    sys.exit("malformed minisign public key")
if len(sig) != 74 or sig[:2] not in (b"Ed", b"ED"):
    sys.exit("malformed minisign signature")
if mode == "decode":
    out_dir = sys.argv[4]
    with open(out_dir + "/key.pub", "w") as f:
        f.write(pub_text)
    with open(out_dir + "/file.minisig", "w") as f:
        f.write(sig_text)
elif pub[2:10] == sig[2:10]:
    print("match")
else:
    print("mismatch")
    sys.exit(1)
PY
}

verify_updater_sig() {
  local file="$1" sig="$2" pubkey="$3" tmp rc=0
  if command -v minisign >/dev/null 2>&1; then
    tmp="$(mktemp -d -t memlore-minisign)"
    updater_sig_tool decode "$pubkey" "$sig" "$tmp" || rc=1
    if [[ $rc -eq 0 ]]; then
      minisign -Vq -p "$tmp/key.pub" -m "$file" -x "$tmp/file.minisig" || rc=1
    fi
    rm -f "$tmp/key.pub" "$tmp/file.minisig"
    rmdir "$tmp"
    [[ $rc -eq 0 ]] || die "$sig does not verify against the updater public key (minisign -V)"
    echo "ok: updater signature verified (minisign)"
  else
    updater_sig_tool keyid "$pubkey" "$sig" >/dev/null \
      || die "$sig was not made by the updater key pinned in tauri.conf.json (key id mismatch)"
    echo "ok: updater signature key id matches (install minisign for a full check)"
  fi
}

# ─── Cleanup ──────────────────────────────────────────────────────────────────
#
# Bash keeps one EXIT trap, so it does everything: detach the DMG, remove the
# decoded profile plist, and, if a draft release exists but was never
# published, say how to recover.

MOUNT=""
PROFILE_PLIST=""
DRAFT_CREATED=0
PUBLISHED=0
TAG=""

cleanup() {
  local rc=$?
  if [[ -n "$MOUNT" ]]; then
    hdiutil detach "$MOUNT" -quiet 2>/dev/null || hdiutil detach "$MOUNT" -force -quiet 2>/dev/null || true
  fi
  if [[ -n "$PROFILE_PLIST" ]]; then
    rm -f "$PROFILE_PLIST"
  fi
  if [[ $rc -ne 0 && $DRAFT_CREATED -eq 1 && $PUBLISHED -eq 0 ]]; then
    echo "" >&2
    echo "The draft release $TAG exists but was not published. Recover with:" >&2
    echo "  bash $SCRIPT_PATH $TAG --resume" >&2
  fi
}

main() {
  local arg dry_run=0 resume=0

  # ─── Arguments ──────────────────────────────────────────────────────────────

  for arg in "$@"; do
    case "$arg" in
      --dry-run) dry_run=1 ;;
      --resume) resume=1 ;;
      -*) usage ;;
      *)
        [[ -z "$TAG" ]] || usage
        TAG="$arg"
        ;;
    esac
  done
  [[ -n "$TAG" ]] || usage

  # ─── Paths ──────────────────────────────────────────────────────────────────

  REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || die "run this from inside the memlore repository"
  [[ -f "$REPO_ROOT/src-tauri/tauri.conf.json" ]] || die "src-tauri/tauri.conf.json not found under REPO_ROOT=$REPO_ROOT"
  # Absolute: cargo resolves a relative CARGO_TARGET_DIR against its own cwd.
  # Pinned so ~/.cargo/config.toml's shared target dir cannot move the bundle.
  export CARGO_TARGET_DIR="$REPO_ROOT/src-tauri/target"
  local bundle_dir="$CARGO_TARGET_DIR/universal-apple-darwin/release/bundle"
  local version="${TAG#v}"

  # shellcheck source=_release-materials.sh
  source "$SCRIPT_DIR/_release-materials.sh"
  trap cleanup EXIT

  # ─── Preflight ──────────────────────────────────────────────────────────────

  step "Preflight"
  [[ "$(uname)" == "Darwin" ]] || die "macOS only"
  [[ "$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] \
    || die "tag must be vX.Y.Z (got '$TAG'); prereleases are discontinued"

  local cmd
  for cmd in git gh pnpm python3 rustup hdiutil xcrun lipo spctl security plutil; do
    command -v "$cmd" >/dev/null 2>&1 || die "$cmd not found on PATH"
  done

  local tag_commit
  tag_commit="$(git -C "$REPO_ROOT" rev-parse -q --verify "refs/tags/$TAG^{commit}")" \
    || die "tag $TAG does not exist locally"
  local local_tag_obj remote_tag_obj
  local_tag_obj="$(git -C "$REPO_ROOT" rev-parse "refs/tags/$TAG")"
  remote_tag_obj="$(git -C "$REPO_ROOT" ls-remote --exit-code --tags origin "refs/tags/$TAG" | awk '{print $1; exit}')" \
    || die "tag $TAG is not on origin (git push origin $TAG)"
  [[ "$remote_tag_obj" == "$local_tag_obj" ]] || die "tag $TAG on origin differs from the local tag"
  [[ "$(git -C "$REPO_ROOT" rev-parse HEAD)" == "$tag_commit" ]] \
    || die "HEAD is not $TAG's commit (git checkout --detach $TAG)"
  [[ -z "$(git -C "$REPO_ROOT" status --porcelain)" ]] \
    || die "working tree is not clean (git status)"

  # status --porcelain ignores gitignored paths, so it cannot see node_modules.
  (cd "$REPO_ROOT" && pnpm install --frozen-lockfile) \
    || die "pnpm install --frozen-lockfile failed (pnpm-lock.yaml out of date?)"
  [[ -z "$(git -C "$REPO_ROOT" status --porcelain)" ]] \
    || die "pnpm install changed the working tree (git status)"

  local conf_version
  conf_version="$(python3 -I -c 'import json, sys; print(json.load(open(sys.argv[1]))["version"])' \
    "$REPO_ROOT/src-tauri/tauri.conf.json")"
  [[ "$conf_version" == "$version" ]] \
    || die "tauri.conf.json version is $conf_version, tag is $TAG"

  local targets target
  targets="$(rustup target list --installed)"
  for target in aarch64-apple-darwin x86_64-apple-darwin; do
    grep -qx "$target" <<<"$targets" || die "rust target $target missing (rustup target add $target)"
  done
  echo "ok: $TAG at $tag_commit, clean tree, version $version"

  # ─── Materials ──────────────────────────────────────────────────────────────
  #
  # Before any GitHub call, so missing secrets always surface first. Only names
  # and ok/missing are printed.

  step "Materials"
  if ! load_release_secrets APPLE_API_ISSUER APPLE_API_KEY GDRIVE_CLIENT_ID \
    GDRIVE_CLIENT_SECRET GOOGLE_FONTS_API_KEY MEMLORE_MAPKIT_TOKEN; then
    die "release secrets incomplete (see .github/release-setup.md)"
  fi

  local api_key_path="$REPO_ROOT/docs/release-secrets/AuthKey.p8"
  [[ -f "$api_key_path" ]] || die "missing: $api_key_path"
  export APPLE_API_KEY_PATH="$api_key_path"
  echo "ok: APPLE_API_KEY_PATH"

  # Ported from release.yml "Stage provisioning profile and check it". An
  # expired or Mac Development profile ships an app that launches for nobody.
  local profile="$REPO_ROOT/.ci/memlore.provisionprofile"
  [[ -f "$profile" ]] || die "missing: $profile (the Developer ID provisioning profile)"
  PROFILE_PLIST="$(mktemp -t memlore-profile)"
  security cms -D -i "$profile" >"$PROFILE_PLIST" 2>/dev/null \
    || die "$profile is not a decodable provisioning profile"
  local p_name p_expiry p_all_devices p_team
  p_name="$(plutil -extract Name raw "$PROFILE_PLIST")"
  p_expiry="$(plutil -extract ExpirationDate raw "$PROFILE_PLIST")"
  # Absent from Mac Development profiles, which is the case being detected.
  p_all_devices="$(plutil -extract ProvisionsAllDevices raw "$PROFILE_PLIST" 2>/dev/null || echo false)"
  p_team="$(plutil -extract TeamIdentifier.0 raw "$PROFILE_PLIST")"
  echo "Profile: $p_name (team $p_team, ProvisionsAllDevices=$p_all_devices, expires $p_expiry)"
  [[ "$p_all_devices" == "true" ]] \
    || die "not a Developer ID profile (ProvisionsAllDevices=$p_all_devices)"
  [[ "$p_team" =~ ^[A-Z0-9]{10}$ ]] || die "profile TeamIdentifier is malformed: '$p_team'"
  # plutil raw emits ISO-8601 ("2044-09-10T04:00:02Z").
  local expiry_epoch days_left
  expiry_epoch="$(date -j -u -f "%Y-%m-%dT%H:%M:%SZ" "$p_expiry" "+%s")"
  days_left="$(((expiry_epoch - $(date -u "+%s")) / 86400))"
  [[ "$days_left" -ge 30 ]] \
    || die "provisioning profile expires in $days_left days; renew it before releasing"
  echo "ok: provisioning profile ($days_left days left)"

  # No `| head` under pipefail: awk consumes all input instead.
  local identities identity
  identities="$(security find-identity -v -p codesigning login.keychain || true)"
  identity="$(awk -F'"' -v team="($p_team)" '
    /Developer ID Application/ && substr($2, length($2) - length(team) + 1) == team { print $2; exit }
  ' <<<"$identities")"
  [[ -n "$identity" ]] \
    || die "no 'Developer ID Application' identity for team $p_team in the login keychain"
  export APPLE_SIGNING_IDENTITY="$identity"
  echo "ok: APPLE_SIGNING_IDENTITY ($identity)"

  local tauri_key="$HOME/.tauri/memlore.key"
  [[ -s "$tauri_key" ]] || die "missing: $tauri_key"
  [[ -f "$tauri_key.password" ]] || die "missing: $tauri_key.password"
  # $(<file) drops the trailing newline.
  TAURI_SIGNING_PRIVATE_KEY="$(<"$tauri_key")"
  TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$(<"$tauri_key.password")"
  export TAURI_SIGNING_PRIVATE_KEY TAURI_SIGNING_PRIVATE_KEY_PASSWORD
  echo "ok: TAURI_SIGNING_PRIVATE_KEY"
  echo "ok: TAURI_SIGNING_PRIVATE_KEY_PASSWORD"

  # Tauri writes the .pub file as base64 of the minisign public key, the same
  # encoding tauri.conf.json pins, so the two compare as plain strings. A
  # mismatch ships an update every installed build rejects.
  local updater_pubkey conf_pubkey
  [[ -s "$tauri_key.pub" ]] || die "missing: $tauri_key.pub"
  updater_pubkey="$(tr -d '[:space:]' <"$tauri_key.pub")"
  conf_pubkey="$(python3 -I -c 'import json, sys; print(json.load(open(sys.argv[1]))["plugins"]["updater"]["pubkey"])' \
    "$REPO_ROOT/src-tauri/tauri.conf.json" | tr -d '[:space:]')" \
    || die "could not read plugins.updater.pubkey from tauri.conf.json"
  [[ -n "$conf_pubkey" && "$updater_pubkey" == "$conf_pubkey" ]] \
    || die "$tauri_key.pub does not match plugins.updater.pubkey in tauri.conf.json"
  echo "ok: updater public key matches tauri.conf.json"

  # API-key notarization must be the only auth path.
  unset APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID

  local repo_slug
  repo_slug="$(gh repo view --json nameWithOwner --jq .nameWithOwner)" \
    || die "gh repo view failed (gh auth status)"
  [[ -n "$repo_slug" ]] || die "gh repo view returned no nameWithOwner"

  # ─── Release state ──────────────────────────────────────────────────────────

  if [[ $dry_run -eq 0 ]]; then
    step "Release state"
    local is_draft err_file
    err_file="$(mktemp -t memlore-gh)"
    if is_draft="$(gh release view "$TAG" --json isDraft --jq .isDraft 2>"$err_file")"; then
      rm -f "$err_file"
      if [[ "$is_draft" == "true" ]]; then
        if [[ $resume -eq 0 ]]; then
          echo "A draft release $TAG already exists (an earlier run died). Recover with:" >&2
          echo "  bash $SCRIPT_PATH $TAG --resume" >&2
          exit 1
        fi
        echo "Deleting the unpublished draft $TAG (the tag stays)…"
        gh release delete "$TAG" --yes
      else
        die "release $TAG is already published"
      fi
    elif grep -q "release not found" "$err_file"; then
      rm -f "$err_file"
      echo "ok: no release for $TAG yet"
    else
      cat "$err_file" >&2
      rm -f "$err_file"
      die "gh release view $TAG failed"
    fi
  fi

  # ─── Build ──────────────────────────────────────────────────────────────────

  local dmg="$bundle_dir/dmg/Memlore_${version}_universal.dmg"
  local tarball="$bundle_dir/macos/Memlore.app.tar.gz"
  # Remove outputs of an earlier build so only this build's files get verified.
  rm -f "$dmg" "$tarball" "$tarball.sig"

  step "Build (signs, notarizes, staples)"
  (cd "$REPO_ROOT" && pnpm tauri build --target universal-apple-darwin)

  [[ -f "$dmg" ]] || die "build produced no $dmg"
  [[ -f "$tarball" ]] || die "build produced no $tarball"
  [[ -s "$tarball.sig" ]] || die "updater signature $tarball.sig is missing or empty"
  verify_updater_sig "$tarball" "$tarball.sig" "$conf_pubkey"

  # ─── Verify inside the DMG (what users receive) ─────────────────────────────

  step "Verify the DMG"
  local attach_plist
  attach_plist="$(hdiutil attach -nobrowse -readonly -plist "$dmg")"
  MOUNT="$(python3 -I -c '
import plistlib, sys
for e in plistlib.loads(sys.stdin.buffer.read()).get("system-entities", []):
    if e.get("mount-point"):
        print(e["mount-point"])
        break
' <<<"$attach_plist")"
  [[ -n "$MOUNT" ]] || die "could not find the mount point of $dmg"

  local app="$MOUNT/Memlore.app"
  [[ -d "$app" ]] || die "Memlore.app not found in the DMG"
  local spctl_out
  spctl_out="$(spctl -a -vv -t install "$app" 2>&1)" || die "spctl rejected the app: $spctl_out"
  [[ "$spctl_out" == *"Notarized Developer ID"* ]] || die "app is not notarized: $spctl_out"
  echo "ok: notarized Developer ID"
  xcrun stapler validate "$app" >/dev/null || die "notarization ticket is not stapled"
  echo "ok: stapled"
  local exe archs
  exe="$(plutil -extract CFBundleExecutable raw "$app/Contents/Info.plist")"
  archs="$(lipo -archs "$app/Contents/MacOS/$exe")"
  [[ " $archs " == *" x86_64 "* && " $archs " == *" arm64 "* ]] \
    || die "app is not universal (archs: $archs)"
  echo "ok: universal ($archs)"
  [[ -f "$app/Contents/embedded.provisionprofile" ]] || die "embedded.provisionprofile missing from the app"
  echo "ok: embedded.provisionprofile"
  hdiutil detach "$MOUNT" -quiet
  MOUNT=""

  # ─── Assets ─────────────────────────────────────────────────────────────────

  step "Assets"
  local work_dir asset_dir notes_file
  work_dir="$(mktemp -d -t memlore-release)"
  asset_dir="$work_dir/assets"
  notes_file="$work_dir/notes.md"
  mkdir "$asset_dir"

  local asset_tar="Memlore_${version}_universal.app.tar.gz"
  local asset_dmg="Memlore_${version}_universal.dmg"
  cp "$dmg" "$asset_dir/$asset_dmg"
  # Renaming keeps the minisign signature valid: it covers bytes, not the name.
  cp "$tarball" "$asset_dir/$asset_tar"
  cp "$tarball.sig" "$asset_dir/$asset_tar.sig"

  local notes
  notes="$(bash "$REPO_ROOT/scripts/release-notes.sh" "$version")"
  notes="${notes#"${notes%%[![:space:]]*}"}" # leading blank line, trimmed like tauri-action
  printf '%s\n' "$notes" >"$notes_file"

  write_latest_json "$asset_dir/latest.json" "$version" "$notes_file" "$asset_dir/$asset_tar.sig" \
    "https://github.com/$repo_slug/releases/download/$TAG/$asset_tar"
  assert_latest_json "$asset_dir/latest.json"
  echo "ok: $asset_dir"

  if [[ $dry_run -eq 1 ]]; then
    echo ""
    echo "Dry run complete. Assets: $asset_dir"
    echo "No GitHub Release was touched, but a real notarization was submitted to Apple."
    return 0
  fi

  # ─── Publish ────────────────────────────────────────────────────────────────
  #
  # Draft first: clients never see a draft, so a partial upload stays invisible
  # until all 4 assets are confirmed.

  step "Publish"
  gh release create "$TAG" --verify-tag --draft --title "Memlore $TAG" --notes-file "$notes_file"
  DRAFT_CREATED=1
  gh release upload "$TAG" "$asset_dir/$asset_dmg" "$asset_dir/$asset_tar" \
    "$asset_dir/$asset_tar.sig" "$asset_dir/latest.json"

  local uploaded name
  uploaded="$(gh release view "$TAG" --json assets --jq '.assets[].name')"
  for name in "$asset_dmg" "$asset_tar" "$asset_tar.sig" latest.json; do
    grep -qxF "$name" <<<"$uploaded" || die "asset $name is missing from the draft release"
  done
  echo "ok: 4 assets uploaded"

  gh release edit "$TAG" --draft=false --latest
  PUBLISHED=1
  echo ""
  echo "Published $TAG: https://github.com/$repo_slug/releases/tag/$TAG"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
