# `/cf-ship` for Memlore — usage

How to release Memlore. This file is for **you**; `SKILL.md` next to it is the
contract the model follows.

> `.gitignore` ignores `.coding-friend/*` but re-includes
> `!.coding-friend/skills/`, so this guide, `SKILL.md` and the scripts **are**
> version-controlled and do reach a fresh clone. Only `.coding-friend/config.json`
> stays local.

## Two platforms, shipped separately

Memlore ships two platforms. Each has its own version, its own tags and its own
pipeline, and one never moves the other:

| Platform            | Flag    | Version file                | Tag          | Built and published by (default: this Mac)                                       | With `--cloud`   |
| ------------------- | ------- | --------------------------- | ------------ | -------------------------------------------------------------------------------- | ---------------- |
| Desktop app (macOS) | `--mac` | `src-tauri/tauri.conf.json` | `v0.2.1`     | `release-mac-local.sh`: signed + notarized `.dmg`, GitHub Release, in-app update | `release.yml`    |
| Web companion       | `--web` | `web/version.json`          | `web-v0.1.0` | `deploy-web-local.sh`: Cloudflare Pages, plus the OAuth Worker when it changed   | `deploy-web.yml` |

| You say          | What happens                                                                        |
| ---------------- | ----------------------------------------------------------------------------------- |
| `/cf-ship`       | The model **asks** `--mac`, `--web` or `--all` first. It never guesses.             |
| `/cf-ship --mac` | Desktop only: bump, changelog, `v*` tag, signed release. The web is untouched.      |
| `/cf-ship --web` | Web only: bump, changelog, `web-v*` tag, deploy. The desktop is untouched.          |
| `/cf-ship --all` | Each platform that has changes, independently: its own level, version, tag, deploy. |

The flags below (`patch|minor|major`, `--cloud`) combine with a platform:
`/cf-ship --mac minor`, `/cf-ship --web --cloud`.

**Pushing a tag triggers nothing.** By default `/cf-ship` builds and publishes
on this Mac, from the tag commit, with the scripts in `scripts/`. `--cloud`
dispatches the GitHub workflow on the tag instead
(`gh workflow run release.yml --ref v<version>`). Neither workflow runs on a
tag push.

The web is **never deployed by hand from a branch**: it deploys only from a
`web-v*` tag commit, through `deploy-web-local.sh` or `--cloud`. And a web tag
**never gets a GitHub Release** — the desktop updater reads GitHub Releases, so
one would break desktop updates.

## What one release actually does

`/cf-ship` reads the commits since the platform's last published tag, picks a
version, runs `pnpm format` and commits the formatter's changes on their own
(`style(release): format before release`), then writes both changelogs, bumps
the version file(s), runs the tests (the only test gate), commits, tags,
pushes, builds and publishes, and finally verifies what it published.

- **mac:** `release-mac-local.sh` builds the universal app, signs and
  notarizes it, checks the `.dmg`, then publishes it plus the `latest.json` the
  in-app updater reads (as a draft first, made public once all 4 assets are
  uploaded). The first local build is cold; later ones reuse the cargo cache.
  `--cloud` takes **25-35 minutes**, almost all of it the cold universal Rust
  build.
- **web:** `deploy-web-local.sh` builds and deploys to Cloudflare Pages, and
  redeploys the Worker only when `workers/web-auth/` changed since the previous
  web tag. It runs **no tests**; the `/cf-ship` test step before it is the
  gate. `--cloud` tests again and takes **10-15 minutes**.

The local scripts need a clean working tree, HEAD at the tag's commit, and the
release materials in `docs/release-secrets/` (`release.secrets`, `AuthKey.p8`;
setup in `.github/release-setup.md`). When one is missing, the script prints
`missing: <name>` and `/cf-ship` stops and tells you. It never falls back to
`--cloud` on its own.

## Say it in one line

Shown with `--mac`; every row works the same with `--web` (and `--all`).

**Releases are stable only.** Prereleases are discontinued; `--rc` / `--beta` are rejected.

| You want                                      | You say                  | Version goes                           |
| --------------------------------------------- | ------------------------ | -------------------------------------- |
| A normal release                              | `/cf-ship --mac`         | `0.1.0` → `0.1.1`                      |
| Let the model pick the level from the commits | `/cf-ship --mac`         | patch, unless the bar below is cleared |
| Force the level                               | `/cf-ship --mac minor`   | `0.1.0` → `0.2.0`                      |
| Build on GitHub Actions instead of this Mac   | `/cf-ship --mac --cloud` | `0.1.0` → `0.1.1`                      |

### When the model picks the level

**Patch is the default.** A minor bump happens only when the commits since the
last tag contain **both** of these:

1. **Several distinct new features** — more than one, each something a user can
   invoke or opt into on its own. Commits that are pieces of a single feature
   count as one feature.
2. **A large release overall** — many release-relevant commits spanning those
   features, not a short series around one theme.

One new capability is a patch, however large its diff is. So is new UI on a
surface that already exists, and so is a release that is mostly fixes with a
feature mixed in. An `Added` changelog heading does not make the bump minor.
When it is close, the model ships a patch. Pass `minor` yourself only when you
want to override that.

`bump-info.sh` computes the version itself and prints it under **Next
version**; it still handles promotion from a historical rc file version
(`0.1.1-rc.2` → `0.1.1`, never `0.1.2`).

## Who sees what

**Desktop:** every release is a normal GitHub Release. The app's stable
channel reads `/releases/latest/download/latest.json`; its beta channel asks
the API for the newest releases and takes the first `v*` tag, which is now
always a stable one, so both channels get the same build.

**Web** has no channels. A `web-v0.1.1` tag deploys `web.memlore.app`, and the
deploy then publishes a `web-v0.1.1` GitHub Release with its `CHANGELOG.md`
section as notes. It is created with `--latest=false`, so `/releases/latest`
stays on the desktop release, and it is skipped until the latest desktop
release is v0.2.6 or newer (v0.2.5 and older stop at a `web-v*` release on
their beta channel). That floor does not help a beta user still running
v0.2.5 or older: they see an update only while a `v*` release is the newest
one, until they update once or switch to stable. Accepted on purpose.

The historical `v0.1.0-rc.1` stays published: a published prerelease tag or release is never deleted.

## Three things that will bite you

**1. The local build refuses a dirty tree.**
`release-mac-local.sh` and `deploy-web-local.sh` build from the tag commit and
stop when the working tree has any change, untracked files included. Work in
progress left unstaged by the format step is yours: `/cf-ship` reports it and
stops rather than stash, commit or delete it. With `--all`, it checks out each
tag (detached) before its script and returns to `main` after.

**2. "Nothing to release" is a real answer.**
Each platform counts only its own paths: `src/` and `public/` (the shared UI)
count for both; `web/` and `workers/` only for web; `src-tauri/` for mac, except
`crates/memlore-core` and `crates/memlore-wasm`, which count for web too.
`website/`, `mockup/`, `docs/` and `e2e/` count for neither, and neither do
`(website)`- or `(release)`-scoped commits. When nothing relevant changed, the
report says `HAS APP CHANGES: no`. That means stop — not "ship a patch anyway"
(with `--all`, that platform is skipped). Website changes deploy through
`deploy-website.yml` on push to `main` and need no version at all.

**3. There are two changelogs, with two audiences.**

| File                                     | For        | Style                                                                                            |
| ---------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------ |
| `CHANGELOG.md`                           | developers | technical; `## v…` sections become the GitHub Release body, `## web-v…` sections are for the web |
| `website/src/changelog/changelogData.ts` | users      | plain language; drives the public changelog page and the version badge on the site               |

Both get updated every release. Web entries carry `platform: 'web'` and show as
"Web v…" with a Web chip. The website badge reads the newest **stable desktop**
entry, so a web version never becomes the badge.

## What the report looks like

```
=== Bump Info — memlore --mac: desktop app (macOS) ===

Latest published tag:  v0.1.0
Tag source:            origin
Tag format:            v<version>   (this platform only)
File version:          0.1.0  (src-tauri/tauri.conf.json)
State:                 bump
Commit range:          v0.1.0..HEAD
Requested level:       (none — decide from the commits below)
Prerelease:            no — STABLE only (prereleases are discontinued)

--- Next version (computed — do NOT do this arithmetic yourself) ---
  patch    0.1.1
  minor    0.2.0
  major    1.0.0
```

`State` is the thing to read first:

| State                      | Meaning                                                                                                |
| -------------------------- | ------------------------------------------------------------------------------------------------------ |
| `bump`                     | Normal. Pick a version and go.                                                                         |
| `already-bumped`           | The version files are ahead of the tag — the bump already happened. Changelog only; do not bump again. |
| `first-release`            | No tag exists at all. Ship the version already in the files.                                           |
| `BROKEN-tag-ahead-of-file` | Something was tagged without bumping. Stop and untangle it by hand.                                    |

## When it goes wrong

**The build fails.** Never move or delete the tag. Locally: fix the problem and
re-run the same script on the same tag. If `release-mac-local.sh` says a draft
release already exists (an earlier run died after creating it), add
`--resume`: it deletes only that draft, which no client can see, and rebuilds:

```bash
bash .coding-friend/skills/cf-ship-custom/scripts/release-mac-local.sh v<version> --resume
```

With `--cloud`: fix the problem and dispatch again,
`gh workflow run release.yml --ref v<version>` (or `deploy-web.yml --ref web-v<version>`).
A failed mac run is not always release-free: `release.yml` publishes directly
(`releaseDraft: false`), so a failure after the build can leave a published
release with assets missing. Check `gh release view v<version> --json isDraft,assets`
first; the workflow refuses a tag that already has a release, and a tag whose
commit is not on `main`. A draft must be
deleted first (`gh release delete v<version> --yes`, never `--cleanup-tag`); a
published one ships as the next patch. Never dispatch `--cloud` on a tag cut before these guards
(`v0.2.3`, `web-v0.2.1` and older): a dispatch runs the tag's own, older workflow.

A fix that needs a code change ships as the next patch: the tag never moves,
and `bump-info.sh` then sees the pushed but unreleased tag as the latest and
offers the next patch.

**A script prints `missing: <name>`.** A release material is absent from
`docs/release-secrets/` (or `.ci/`, `~/.tauri/`). Add it as described in
`.github/release-setup.md`, then run `/cf-ship` again. The model reports the
names and stops; it never prints a secret value and never switches to
`--cloud` by itself.

**The run is green but the app will not update.** Check `latest.json`: every
platform key needs a non-empty `signature`. An empty one is the silent failure
mode — the release looks perfect and every client refuses the update. Step B8
checks this, but check it yourself if you are suspicious:

```bash
gh release download v<version> -p latest.json -O - | python3 -m json.tool
```

**Gatekeeper warns users.** Notarization did not take. `release-mac-local.sh`
checks this on its own `.dmg` before uploading; to check what users download,
on the downloaded `.dmg`:

```bash
spctl -a -vv -t install "/Volumes/Memlore/Memlore.app"   # want: accepted / Notarized Developer ID
```

**Touch ID stops working in the release.** The provisioning profile did not get
embedded. `Contents/embedded.provisionprofile` must exist inside the shipped
`.app`, or macOS kills the process at launch — see
`scripts/build-signed-app.sh`'s header for why.

## What it does not do

- **Renew the provisioning profile.** It expires in 2044, and
  `release-mac-local.sh` and `release.yml` refuse to build under 30 days
  remaining. Nothing to do for years.
- **Rotate the updater signing key.** It _cannot_ be rotated — the public half
  is compiled into every shipped build. Never re-run `tauri signer generate`.
  See `.github/release-setup.md`.
- **Release the website.** That is `deploy-website.yml`, triggered by any push
  to `main`. (The web _companion_ is a platform and does go through `/cf-ship --web`.)
- **Release for Windows or Linux.** macOS only today.

## Testing the scripts without releasing anything

Two env hooks let you exercise every branch without touching the real config or
creating a tag. Never set either during a real release — the output labels
itself `TEST MODE` when they are on.

```bash
B=.coding-friend/skills/cf-ship-custom/scripts/bump-info.sh

# Pretend we are sitting on a historical candidate: shows the promote answer.
BUMP_INFO_TAG=v0.1.1-rc.2 BUMP_INFO_VERSION=0.1.1-rc.2 bash $B --mac

# The same for the web (its tags carry the web- prefix).
BUMP_INFO_TAG=web-v0.1.1-rc.2 BUMP_INFO_VERSION=0.1.1-rc.2 bash $B --web

# The rejected flag.
bash $B --mac --rc   # prereleases are discontinued: exits 1

# Pretend nothing was ever released.
BUMP_INFO_TAG= bash $B --web
```

## Files

| Path                               | Role                                                                                                                            |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `SKILL.md`                         | The contract the model follows. Loaded by `load-custom-guide.sh`.                                                               |
| `scripts/bump-info.sh`             | Per platform (`--mac`/`--web`): reads commits and tags, names the state, computes the next version. Writes nothing.             |
| `scripts/bump.sh`                  | Per platform: writes the version file(s) — four for mac, `web/version.json` for web — and verifies them.                        |
| `scripts/release-mac-local.sh`     | mac, default: builds universal, signs, notarizes, verifies, publishes the release (draft first; `--resume`, `--dry-run`).       |
| `scripts/deploy-web-local.sh`      | web, default: builds, deploys Pages production and the Worker when changed. Runs no tests.                                      |
| `scripts/_release-materials.sh`    | Sourced helper: loads only the named keys from `docs/release-secrets/release.secrets`, prints `ok:` / `missing:`, never values. |
| `.github/workflows/release.yml`    | mac, `--cloud` only (`workflow_dispatch`): signs, notarizes, builds universal, publishes.                                       |
| `.github/workflows/deploy-web.yml` | web, `--cloud` only (`workflow_dispatch`): tests, builds, deploys Pages production and the Worker when changed.                 |
| `.github/release-setup.md`         | Every secret and local release material, and where it comes from.                                                               |
