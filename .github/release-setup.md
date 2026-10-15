# Release setup

Everything needed to publish a signed, notarized macOS build: the local
materials the default release path reads on this Mac, and the GitHub secrets
`.github/workflows/release.yml` reads for `/cf-ship --cloud`. Maintainer
reference — you only do this once.

> This lives in `.github/` rather than `docs/` on purpose: `docs/` is gitignored
> in this repository, so anything written there never reaches a clone.

## How a release happens

1. `/cf-ship` decides the version bump from the commits, updates `CHANGELOG.md`
   and the website changelog, bumps the four version files, and pushes a stable
   `v<version>` tag. Pushing a tag starts nothing: both workflows are
   `workflow_dispatch`-only.
2. By default `/cf-ship` then runs
   `.coding-friend/skills/cf-ship-custom/scripts/release-mac-local.sh <tag>` on
   this Mac (see [Local release (default)](#local-release-default)). With
   `--cloud` it runs `gh workflow run release.yml --ref v<version>` instead.
3. Either path signs with Developer ID, notarizes through App Store Connect,
   builds a universal binary, and uploads `.dmg`, `.app.tar.gz`,
   `.app.tar.gz.sig` and `latest.json` to a GitHub Release.
4. Installed apps read `latest.json` and offer the update.

Only stable `vX.Y.Z` tags are released; prereleases (`-beta`, `-rc`) are
discontinued and a tag containing `-` is refused by both paths. The historical
`v0.1.0-rc.1` prerelease stays published. The app still has two update
channels: stable reads `/releases/latest/download/latest.json`, and beta
resolves the newest release through the API, which is now always a stable one,
so beta-channel users simply get stable releases.

The web companion ships the same way under its own stable `web-v<version>`
tags: `deploy-web-local.sh <tag>` from the tag commit by default, or
`gh workflow run deploy-web.yml --ref web-v<version>` with `--cloud`. After the
deploy, both paths publish a GitHub Release for the web tag (notes from its
`CHANGELOG.md` section), always with `--latest=false` so `/releases/latest`
stays on the desktop release. It is skipped while the latest desktop release is
older than v0.2.6: builds up to v0.2.5 take the single newest release on their
beta channel and reject a `web-v*` tag; v0.2.6 skips non-`v*` releases. The
floor does not help a beta user still running v0.2.5 or older: they see an
update only while a `v*` release is the newest one, until they update once or
switch to stable. Accepted on purpose.

Before any secret is read, `release.yml` refuses a tag that already has a
release (a published one would have its live assets and `latest.json`
overwritten; a draft would not be reused but duplicated), and
both workflows refuse a tag whose commit is not on `main`. A dispatch runs the
workflow file **as it was at the tag's commit**, so a tag cut before these
guards existed runs its old workflow without them: never dispatch `--cloud` on
a pre-guard tag (`v0.2.3`, `web-v0.2.1` and older).

## Local release (default)

`release-mac-local.sh` and `deploy-web-local.sh` (in
`.coding-friend/skills/cf-ship-custom/scripts/`) read everything from this Mac.
Nothing below is committed, and no script ever prints a secret value.

### `docs/release-secrets/` (gitignored)

The folder is covered by the `/docs/*` rule in `.gitignore`. It holds two
files:

- **`release.secrets`** — `KEY=value` lines (blank lines and `#` comments are
  skipped, one layer of matching quotes is stripped).
- **`AuthKey.p8`** — the App Store Connect API key used for notarization: the
  `AuthKey_<KEY ID>.p8` Apple let you download once, renamed. Its key ID is the
  `APPLE_API_KEY` value below. The script points `APPLE_API_KEY_PATH` at it.

| Local material                              | Mirrors GitHub secret(s)                                               | Notes                                                                                       |
| ------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `release.secrets` → `APPLE_API_ISSUER`      | `APPLE_API_ISSUER`                                                     | Issuer ID (UUID)                                                                            |
| `release.secrets` → `APPLE_API_KEY`         | `APPLE_API_KEY`                                                        | Key ID of `AuthKey.p8`                                                                      |
| `release.secrets` → `GDRIVE_CLIENT_ID`      | `GDRIVE_CLIENT_ID`                                                     | Release value; overrides the dev environment file `build.rs` would otherwise read           |
| `release.secrets` → `GDRIVE_CLIENT_SECRET`  | `GDRIVE_CLIENT_SECRET`                                                 | Same                                                                                        |
| `release.secrets` → `GOOGLE_FONTS_API_KEY`  | `GOOGLE_FONTS_API_KEY`                                                 | Same                                                                                        |
| `release.secrets` → `MEMLORE_MAPKIT_TOKEN`  | `MEMLORE_MAPKIT_TOKEN`                                                 | Same                                                                                        |
| `release.secrets` → `CLOUDFLARE_API_TOKEN`  | `CLOUDFLARE_API_TOKEN`                                                 | Optional, web deploy only. Leave both Cloudflare keys out to use `pnpm exec wrangler login` |
| `release.secrets` → `CLOUDFLARE_ACCOUNT_ID` | `CLOUDFLARE_ACCOUNT_ID`                                                | Optional, web deploy only                                                                   |
| `AuthKey.p8`                                | `APPLE_API_KEY_P8`                                                     | The raw `.p8` file, not base64                                                              |
| `.ci/memlore.provisionprofile`              | `MACOS_PROVISION_PROFILE`                                              | The raw profile, not base64 (see below)                                                     |
| Login keychain identity                     | `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `KEYCHAIN_PASSWORD` | See below                                                                                   |
| `~/.tauri/memlore.key`                      | `TAURI_SIGNING_PRIVATE_KEY`                                            | Updater (minisign) private key                                                              |
| `~/.tauri/memlore.key.password`             | `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`                                   | Its password                                                                                |

Lock the folder down:

```bash
mkdir -p docs/release-secrets
chmod 700 docs/release-secrets
chmod 600 docs/release-secrets/release.secrets docs/release-secrets/AuthKey.p8
git check-ignore -v docs/release-secrets/release.secrets   # must print the /docs/* rule
```

The loader (`_release-materials.sh`) refuses to read the default path unless it
is gitignored, and warns when `release.secrets` is not mode `600`.
`MEMLORE_RELEASE_SECRETS=<path>` points it at another file.

The file is deliberately not given a dot-env style name: a local tooling hook
blocks every shell command whose text contains that suffix, which would block
every command that touches the file.

The loader **parses** the file — it never `source`s or `eval`s it — and exports
only the keys each script asks for: the desktop build gets the six Apple and
build-time keys, never the Cloudflare ones; the web deploy loads only the two
Cloudflare keys, and only after `pnpm web:build`, so the web build runs with no
release secrets.

### Provisioning profile

The existing gitignored `.ci/memlore.provisionprofile` ("Memlore Developer ID")
is the local counterpart of `MACOS_PROVISION_PROFILE`. The script runs the same
checks as the workflow: it must be a Developer ID profile
(`ProvisionsAllDevices`) with at least 30 days of validity left. Scripts only
read it — they never overwrite or delete it. Renewing it means downloading a new
Developer ID profile and replacing that file by hand.

### Signing identity

The **Developer ID Application** certificate in the login keychain stands in for
`APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD` and `KEYCHAIN_PASSWORD`. The
script picks the first one whose team matches the profile's `TeamIdentifier`
(`security find-identity -v -p codesigning login.keychain`) and exports it as
`APPLE_SIGNING_IDENTITY` — as in CI, it is derived, never configured.

On the first release, codesign asks for access to that key: click **Always
Allow** once, or every later build stops at the same prompt.

### Updater key

`~/.tauri/memlore.key`, `~/.tauri/memlore.key.password` and
`~/.tauri/memlore.key.pub`. The script checks that the `.pub` equals
`plugins.updater.pubkey` in `src-tauri/tauri.conf.json` and verifies the built
`.app.tar.gz.sig` against it before anything is uploaded. **Never regenerate
this key** (see [Updater signing](#updater-signing-minisign)).

Optional: `brew install minisign` for a full signature verification; without it
the script only checks that the signature's key ID matches.

### Toolchain and build cache

The script needs `git`, `gh` (authenticated), `pnpm`, `python3`, `rustup` with
the `aarch64-apple-darwin` and `x86_64-apple-darwin` targets, and Xcode command
line tools. It pins `CARGO_TARGET_DIR` to `src-tauri/target` so the bundle stays
in the repo. The first local universal release build is cold (the release
profile and the x86_64 half were never built here); later releases reuse
`src-tauri/target`.

### Checking the materials

Run the loader exactly as the scripts do, from the repo root. It prints only key
names — `ok:` / `missing:` for required keys, `optional: NAME set|unset` for
optional ones — and the `bash -c` keeps the exported values out of your shell:

```bash
bash -c 'set -euo pipefail
  source .coding-friend/skills/cf-ship-custom/scripts/_release-materials.sh
  load_release_secrets --optional CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID -- \
    APPLE_API_ISSUER APPLE_API_KEY GDRIVE_CLIENT_ID GDRIVE_CLIENT_SECRET \
    GOOGLE_FONTS_API_KEY MEMLORE_MAPKIT_TOKEN'
```

Never `cat` the file or `echo` a value to check it. A `missing:` line stops
`/cf-ship`; it never falls back to `--cloud` on its own. The remaining
materials (`AuthKey.p8`, profile, identity, updater key) are checked at the
start of `release-mac-local.sh`, before any build or GitHub call.

## Required secrets

These GitHub secrets are only read by the `/cf-ship --cloud` path
(`gh workflow run release.yml --ref v<version>`,
`gh workflow run deploy-web.yml --ref web-v<version>`). They stay configured as
the fallback; the local materials above mirror them.

Set at
<https://github.com/MemloreApp/memlore/settings/secrets/actions>.

### Code signing

| Secret                       | What it is                                                     | How to produce it                                                                                                                  |
| ---------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `APPLE_CERTIFICATE`          | Base64 of the Developer ID Application certificate as a `.p12` | Keychain Access → My Certificates → right-click _Developer ID Application_ → Export as `.p12`, then `base64 -i cert.p12 \| pbcopy` |
| `APPLE_CERTIFICATE_PASSWORD` | The password set while exporting that `.p12`                   | Chosen at export time                                                                                                              |
| `KEYCHAIN_PASSWORD`          | Any random string                                              | Only ever used for a throwaway keychain inside the CI runner                                                                       |

`APPLE_SIGNING_IDENTITY` is deliberately **not** a secret. The workflow reads it
back out of the certificate it just imported, so it cannot drift from the
certificate actually in use.

### Notarization (App Store Connect API key)

| Secret             | What it is                                | How to produce it                                                                                       |
| ------------------ | ----------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `APPLE_API_ISSUER` | Issuer ID (UUID)                          | App Store Connect → Users and Access → Integrations → App Store Connect API; shown above the keys table |
| `APPLE_API_KEY`    | Key ID (~10 chars)                        | Same table, _KEY ID_ column                                                                             |
| `APPLE_API_KEY_P8` | Base64 of the `AuthKey_*.p8` **contents** | `base64 -i AuthKey_XXXXXXXXXX.p8 \| pbcopy`                                                             |

The `.p8` downloads **once** and Apple will not re-issue it — keep a copy in a
password manager. `APPLE_API_KEY_PATH`, which Tauri actually reads, is a file
path the workflow creates from `APPLE_API_KEY_P8`; it is not a secret.

### Updater signing (minisign)

| Secret                               | What it is                                   | How to produce it                                    |
| ------------------------------------ | -------------------------------------------- | ---------------------------------------------------- |
| `TAURI_SIGNING_PRIVATE_KEY`          | The minisign private key, password-encrypted | `pnpm tauri signer generate -w ~/.tauri/memlore.key` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Its password                                 | Chosen at generation time                            |

> **This key cannot be rotated after the first release.** Its public half is
> compiled into every shipped build (`tauri.conf.json` → `plugins.updater.pubkey`)
> and Tauri's updater has no in-band key rotation. Replacing it means every
> existing install silently stops being able to verify updates and has to be
> re-downloaded by hand. Keep the private key and its password in a password
> manager, and **never re-run `signer generate`** for this project.

### Provisioning profile

| Secret                    | What it is                                                                | How to produce it                                                                                                     |
| ------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `MACOS_PROVISION_PROFILE` | Base64 of a **Developer ID** macOS provisioning profile for `app.memlore` | developer.apple.com → Profiles → **+** → Distribution → _Developer ID_, then `base64 -i x.provisionprofile \| pbcopy` |

This one is not optional. `src-tauri/Entitlements.release.plist` declares
`keychain-access-groups`, which Touch ID unlock needs
(`src-tauri/src/commands/keychain.rs`, `BIOMETRY_CURRENT_SET`), and that
entitlement is provisioning-profile restricted: a bundle declaring it without a
valid embedded profile is **killed at spawn on every user's machine**. The
profile is embedded via `tauri.conf.json` → `bundle.macOS.files`, which the
bundler copies in before codesign runs.

Two traps worth knowing:

- It must be a **Developer ID** profile (`ProvisionsAllDevices => true`). A _Mac
  Development_ profile pins `ProvisionedDevices` to specific machines and cannot
  be distributed. The workflow and `release-mac-local.sh` reject the wrong type
  rather than shipping it.
- An **expired** profile produces an app that launches for nobody. The workflow
  and `release-mac-local.sh` fail the build when under 30 days remain.

### Build-time configuration

`src-tauri/build.rs` embeds these into the binary through `option_env!` at
compile time. A build without them still succeeds and still launches — it just
ships with dead Google Drive sync, blank maps and no Google Fonts, which only
users discover. The workflow asserts all four are present before building, and
`release-mac-local.sh` refuses to build while any of them is `missing:`.

| Secret                 | Setup guide                                               |
| ---------------------- | --------------------------------------------------------- |
| `GDRIVE_CLIENT_ID`     | Google Cloud console → OAuth 2.0 Client IDs (Desktop app) |
| `GDRIVE_CLIENT_SECRET` | Same OAuth client                                         |
| `GOOGLE_FONTS_API_KEY` | Google Cloud console → Fonts Developer API                |
| `MEMLORE_MAPKIT_TOKEN` | `scripts/generate-mapkit-token.mjs`                       |

Longer walkthroughs live in `docs/gdrive-oauth-setup.md` and
`docs/mapkit-js-setup.md` — **local-only**, since `docs/` is gitignored. If you
are reading this from a fresh clone, those files are not there; the table above
is self-sufficient.

> 🚨 **Release blocker, not a secret:** the Google Cloud OAuth consent screen
> must be set to **In production**, not **Testing**. A Testing project with an
> External user type issues refresh tokens that expire after **7 days**, so
> every user silently loses Drive sync once a week and has to reconnect. Setting
> the secrets correctly does not fix this — it is a console setting.
>
> Publishing needs no heavyweight review: Memlore requests only `drive.appdata`,
> which Google classifies as **non-sensitive**, so no CASA assessment and no
> annual audit. It does need a Privacy policy URL and a Homepage URL on the
> consent screen. Optional _brand verification_ only affects whether the app
> name and logo appear on Google's consent screen.

### Web deploy (Cloudflare)

| Secret                  | What it is                                                       |
| ----------------------- | ---------------------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`  | API token allowed to deploy Pages (`memlore-web`) and the Worker |
| `CLOUDFLARE_ACCOUNT_ID` | The Cloudflare account ID                                        |

Read by `deploy-web.yml` only. Locally they are optional: `pnpm exec wrangler login`
works instead.

## Verifying a release

`release-mac-local.sh` already runs `spctl`, `xcrun stapler validate`, `lipo`
and the entitlement and embedded-profile checks on the local bundle before it
publishes. After either path, check the published release:

```bash
# --cloud only: watch the dispatched run.
gh run list --workflow=release.yml --limit 3

# Four assets, isDraft=false, isPrerelease=false.
gh release view <tag> --json assets,isDraft,isPrerelease

# latest.json must carry a non-empty signature for the platform key the app
# looks up. An empty one is the silent failure mode of updater signing: the
# release looks complete and every client rejects the update.
gh release download <tag> -p latest.json -O - | python3 -m json.tool

# On a Mac that has never built this app — mount the dmg, then:
APP="$(mount | sed -n 's/.* on \(\/Volumes\/Memlore[^ ]*\) .*/\1/p' | head -1)/Memlore.app"
spctl -a -vv -t install "$APP"                      # expect: accepted, Notarized Developer ID
lipo -archs "$APP/Contents/MacOS/Memlore"           # expect: x86_64 arm64
codesign -d --entitlements - "$APP" | grep -c keychain-access-groups   # expect: 1
ls "$APP/Contents/embedded.provisionprofile"        # must exist, or Touch ID is dead
```

Then check in the installed app: Drive sync connects, the map view renders, and
`Memlore > Check For Updates…` reports the right state.

Pushing a tag starts nothing. If a local run fails, fix the cause and run
`release-mac-local.sh <tag>` again, adding `--resume` when it died after
creating the draft release (the draft is deleted, never the tag). With
`--cloud`, check `gh release view <tag> --json isDraft,assets` first:
`release.yml` publishes directly (`releaseDraft: false`), so a run that fails
after the build can leave a published release with assets missing. No
release: re-run `gh workflow run release.yml --ref <tag>`. A draft: delete it
(`gh release delete <tag> --yes`, never `--cleanup-tag`) before dispatching, or
finish it locally with `release-mac-local.sh <tag> --resume`. Published: the
guard refuses a re-run, so ship the next patch, which becomes
`/releases/latest`. A fix that needs a code change also ships as the next
patch: the tag never moves, and `bump-info.sh` then sees the pushed but
unreleased tag as the latest and offers the next patch.
