# Changelog

Developer-facing release notes for both platforms. `## v…` sections are the desktop app; each one becomes the body of its GitHub Release. `## web-v…` sections are the web companion (web.memlore.app), which has its own versions; each one becomes the body of its web GitHub Release (published once the latest desktop release is v0.2.6 or newer). The plain-language version for users lives on the website's changelog page.

Versions follow semver, per platform. Desktop bumps count changes under `src/`, `src-tauri/`, `public/`, `index.html`, `vite.config.ts` and `package.json`; web bumps count `web/`, `workers/web-auth/`, `src/`, `public/`, the `memlore-core` and `memlore-wasm` crates and `package.json`. `website/`, `mockup/`, `docs/` and `e2e/` count for neither.

## web-v0.2.4 (2026-10-16)

### Improved

- **Clearer unlock and sign-out.** The lock screen says "too many attempts, try again in N s" instead of "wrong password" during the backoff, and "Forget this browser" warns when the Google sign-in cookie could not be cleared. [#dd56e6a](https://github.com/MemloreApp/memlore/commit/dd56e6a)
- **Auto-lock applies to every open tab.** Changing the auto-lock time in one tab updates all unlocked tabs of the browser. [#d0f394a](https://github.com/MemloreApp/memlore/commit/d0f394a)
- **Clearer sync notices.** A refused change names the entry as "Untitled" instead of a raw id, an entry moved into a journal the desktop could not create gets one combined note, and the Vietnamese "changed on desktop" wording fits tags and journals. [#d0f394a](https://github.com/MemloreApp/memlore/commit/d0f394a)
- **Chat in the command palette.** The palette lists Chat, AI Memories and Persona on the web when they are readable. [#ac2abea](https://github.com/MemloreApp/memlore/commit/ac2abea)

### Fixed

- **Edits survive a desktop trash and restore.** A pushed edit is kept while the desktop has the entry in Trash and sent again after the entry is restored, with its title and tag changes rebased onto the restored entry. [#043aecf](https://github.com/MemloreApp/memlore/commit/043aecf)
- **Attached pasted images no longer show a Recover banner on the desktop.** The attach choice travels right behind its entry and heals itself if the desktop refused it early; a refused choice falls back to inline. [#043aecf](https://github.com/MemloreApp/memlore/commit/043aecf) [#12ae174](https://github.com/MemloreApp/memlore/commit/12ae174)
- **Orphaned upload blobs are swept** once no draft names them. [#043aecf](https://github.com/MemloreApp/memlore/commit/043aecf)
- **Fail-closed lock and reads.** The cross-tab lock epoch locks the tab when storage becomes unreadable, a copy older than its index winner is never shown, streaks are not returned across a lock, and a pending-change check reports a failed load instead of "not synced". [#dd56e6a](https://github.com/MemloreApp/memlore/commit/dd56e6a) [#d0f394a](https://github.com/MemloreApp/memlore/commit/d0f394a)
- **Boot probe and MapTiler key.** A blocked probe database no longer shows a false "unsupported" screen, and the MapTiler key length is checked in bytes so a stored key always reads back. [#dd56e6a](https://github.com/MemloreApp/memlore/commit/dd56e6a) [#d0f394a](https://github.com/MemloreApp/memlore/commit/d0f394a)
- **Web edits are no longer shown as applied before the desktop republishes** them. [#12ae174](https://github.com/MemloreApp/memlore/commit/12ae174)
- **Dashboard and editor polish.** Dashboard cards roll over at midnight, the Photos tile has an accessible name, recent entries refresh without flashing, a trashed entry shows a single banner without Highlights, double-clicking Restore in Trash is ignored, and exported Markdown links to media with spaces or brackets work. [#d7832e4](https://github.com/MemloreApp/memlore/commit/d7832e4) [#ac2abea](https://github.com/MemloreApp/memlore/commit/ac2abea)

## v0.2.7 (2026-10-16)

### Improved

- **Conflict copies are labelled.** When two devices edit the same imported entry, the copy gets a "(copy from another device)" suffix in your language. [#6a2ccb7](https://github.com/MemloreApp/memlore/commit/6a2ccb7)
- **Dashboard and editor polish.** Dashboard cards roll over at midnight, the Photos tile has an accessible name, AI cards wait for consent before generating, recent entries refresh without flashing, a trashed entry shows a single banner without Highlights, double-clicking Restore in Trash is ignored, and the attachment strip uses the app tooltip and the same audio durations as the player. [#d7832e4](https://github.com/MemloreApp/memlore/commit/d7832e4) [#ac2abea](https://github.com/MemloreApp/memlore/commit/ac2abea)
- **Markdown export is safer.** Media file names with spaces, brackets or `#` are percent-encoded in links, and a failed export shows a message. [#ac2abea](https://github.com/MemloreApp/memlore/commit/ac2abea)

### Fixed

- **Web edits are acknowledged only after the desktop republishes.** The web no longer shows a change as applied before the data reaches the cloud. [#12ae174](https://github.com/MemloreApp/memlore/commit/12ae174)
- **Media uploaded late is advertised.** A photo or video that finishes uploading after its entry was pushed now reaches your other devices, and an insertion-mode change on the desktop is republished. [#12ae174](https://github.com/MemloreApp/memlore/commit/12ae174)
- **Editor saves keep other writers' changes.** A save from an open editor merges into the stored document instead of overwriting text appended by MCP or merged from the web. [#12ae174](https://github.com/MemloreApp/memlore/commit/12ae174)
- **A re-onboarded browser shows up again** in the device list after a revoke, and a web entry created in a refused journal is acknowledged as refused. [#12ae174](https://github.com/MemloreApp/memlore/commit/12ae174)
- **Sync merge hardening.** One failed entry no longer leaves a duplicate conflict copy, "identical" documents are compared by structure, and media of a losing peer no longer stays shared with the original. [#6a2ccb7](https://github.com/MemloreApp/memlore/commit/6a2ccb7)
- **Imports.** Journey photos get stable ids, re-importing a Markdown folder skips unchanged entries, and leftovers of an interrupted Apple Journal import are cleaned up at unlock without touching saved media. [#6a2ccb7](https://github.com/MemloreApp/memlore/commit/6a2ccb7)
- **AI and persona text.** The indexer never writes embeddings for a deleted, hidden or locked entry, and the persona text keeps joiner characters used by emoji and Persian. [#6a2ccb7](https://github.com/MemloreApp/memlore/commit/6a2ccb7)
- **CLI cancel and builds.** Cancelling a CLI AI run after it stopped early now ends the process, and the vendored `swift-rs` finds its library with the newer SwiftPM layout. [#d672f62](https://github.com/MemloreApp/memlore/commit/d672f62)

## web-v0.2.3 (2026-10-15)

### Improved

- **No more Beta label.** The web app drops its Beta badge and title; it is an official stable release like the desktop app. [#07829cd](https://github.com/MemloreApp/memlore/commit/07829cd)

### Fixed

- **Data loss and forward compatibility.** Drive requests, push and pull, and the vault handle failures and newer-format files without losing or skipping data. [#03c98e0](https://github.com/MemloreApp/memlore/commit/03c98e0)
- **Security, crash and UX.** Sign-in and device onboarding, version history and attachment downloads are hardened, and a crash in `web/main.tsx` is fixed. [#e3b0fe7](https://github.com/MemloreApp/memlore/commit/e3b0fe7)
- **Shared UI and lock hygiene.** The lock state is cleared reliably, the media cache setting is corrected, and accessibility and translation gaps are closed. [#7a579d6](https://github.com/MemloreApp/memlore/commit/7a579d6)
- **Attached PDFs open in Brave.** The PDF viewer no longer sets an iframe sandbox that Brave blocked. [#ef3ccf5](https://github.com/MemloreApp/memlore/commit/ef3ccf5)

## v0.2.6 (2026-10-15)

### Improved

- **One update channel, no Beta.** The updater only reads `/releases/latest/download/latest.json`; the beta setting and its `releases?per_page=1` lookup are removed from `src-tauri/src/commands/updater.rs`, and every release is a stable `v*` version. [#cb278b1](https://github.com/MemloreApp/memlore/commit/cb278b1) [#acd0354](https://github.com/MemloreApp/memlore/commit/acd0354)

### Fixed

- **Sync data loss.** The sync engine, metadata, media and AI-generated content paths no longer drop or overwrite changes when devices sync. [#e387701](https://github.com/MemloreApp/memlore/commit/e387701)
- **Sync robustness, security and editor integrity.** Outbox import, recovery and Trash handling are hardened, updater checks are stricter, and the editor keeps inline media and the Yjs document consistent. [#356e2e7](https://github.com/MemloreApp/memlore/commit/356e2e7)
- **Shared UI, lock hygiene and accessibility.** Locked entries stay hidden in previews and the lock state is cleared reliably; accessibility and translation gaps are closed. [#7a579d6](https://github.com/MemloreApp/memlore/commit/7a579d6)
- **Attached PDFs open in Brave.** The PDF viewer no longer sets an iframe sandbox that Brave blocked. [#ef3ccf5](https://github.com/MemloreApp/memlore/commit/ef3ccf5)

## v0.2.5 (2026-10-15)

v0.2.4 was tagged but never published: its universal build did not link under Xcode 27. This release carries everything v0.2.4 would have shipped, plus the build fix.

### Added

- **Every web edit applies on desktop.** Sync reads outbox v3 frames, so edits made in Memlore Web to journals, tags, Trash, memories, personas, locations and attachments are imported into the local journal. The desktop advertises v3 in `outbox_versions`, and a v3 kind this build cannot decode stays pending instead of being dropped. [#9b17952](https://github.com/MemloreApp/memlore/commit/9b17952) [#fb48914](https://github.com/MemloreApp/memlore/commit/fb48914)

### Fixed

- **Universal build under Xcode 27.** The release links again on Xcode 27 / Swift 6.4: `build.rs` promotes the swift-rs runtime symbols that SwiftPM now makes local, and a vendored swift-rs 1.0.8 (`src-tauri/vendor/swift-rs`, wired by `[patch.crates-io]`) builds the Swift package for the target arch instead of the host, so the x86_64 half no longer gets an arm64 archive. [#d28ac4a](https://github.com/MemloreApp/memlore/commit/d28ac4a)
- **Imported entries and web round trip.** Entries brought in by an import now sync to your other devices, and edits made on the web make a clean round trip through the editor and the sync engine. [#e0d13d1](https://github.com/MemloreApp/memlore/commit/e0d13d1)
- **UI polish.** Tag colors are kept, the Cancel button of confirm dialogs is translated, and the location row, version history and Trash count are tidied. [#92820a0](https://github.com/MemloreApp/memlore/commit/92820a0)

## web-v0.2.2 (2026-10-15)

### Added

- **Edit and delete more from the web.** Journals, tags, Trash, memories, personas, locations and attachments can be edited or deleted through the outbox v3 frame; desktop 0.2.5 or later applies them, and the web waits while no slot-holding desktop advertises v3. [#fb48914](https://github.com/MemloreApp/memlore/commit/fb48914) [#9b17952](https://github.com/MemloreApp/memlore/commit/9b17952)
- **Browser storage limits, shared sessions and read parity.** The web app now fits within browser storage limits (boot check and a media cache setting), shares one unlocked session across tabs, shows a screen for unsupported browsers, and reads the same entry fields as the desktop. [#4d4b13c](https://github.com/MemloreApp/memlore/commit/4d4b13c)

### Fixed

- **Attached PDFs and leave-page guards.** Attached PDFs open, stale leave-page guards are cleared, and the Trash confirmation copy is corrected. [#2db40f7](https://github.com/MemloreApp/memlore/commit/2db40f7)
- **Web edit round trip.** Drive paths, safe uploads and device bins are corrected so edits made on the web reach the desktop cleanly. [#e0d13d1](https://github.com/MemloreApp/memlore/commit/e0d13d1)
- **UI polish.** Tag colors are kept, the Cancel button of confirm dialogs is translated, and the location row, version history and Trash count are tidied. [#92820a0](https://github.com/MemloreApp/memlore/commit/92820a0)

## web-v0.2.1 (2026-10-11)

### Added

- **Editing on the web is on.** Production now sets `WEB_WRITES_ENABLED = "1"` in `workers/web-auth/wrangler.toml`, so `/api/config` serves `writes: true` and the outbox v2 writes built in web-v0.2.0 reach users: write, edit and delete entries, create journals and tags, create or edit templates. Desktop 0.2.2 or later imports entry edits; journals, tags, templates and Trash wait in the browser until a desktop on 0.2.3 or later holds a device slot. The Worker README documents the rollback. [#52a5ba7](https://github.com/MemloreApp/memlore/commit/52a5ba7)

### Fixed

- **Desktop version in web notices.** Notices that asked for "Memlore desktop 0.3.0 or later" now name 0.2.3, the release that actually reads outbox v2 and the month index. The web About page, the web-vs-desktop docs and the privacy policy (all locales) describe editing as available. [#52a5ba7](https://github.com/MemloreApp/memlore/commit/52a5ba7)

## v0.2.3 (2026-10-11)

### Added

- **Trash on desktop.** Deleted entries go to a Recently deleted tab, a banner shows when you open one from the trash, and the footer has a shortcut. Purging an entry syncs to your other devices. [#ca03296](https://github.com/MemloreApp/memlore/commit/ca03296) [#12e9c51](https://github.com/MemloreApp/memlore/commit/12e9c51) [#abf6605](https://github.com/MemloreApp/memlore/commit/abf6605)
- **Month index and web edits.** Sync writes an encrypted month index for Memlore Web and imports its outbox v2 intents (new entries, journals, tags, templates and trash actions) into the local journal. `memlore-core` gains the outbox v2 intent, version opener and month index types. [#062b0ad](https://github.com/MemloreApp/memlore/commit/062b0ad) [#c6e13cb](https://github.com/MemloreApp/memlore/commit/c6e13cb)
- **Clearer sync status.** The footer shows an icon-only sync status and explains pending work and the first web load. [#8174747](https://github.com/MemloreApp/memlore/commit/8174747) [#0c31d42](https://github.com/MemloreApp/memlore/commit/0c31d42)

### Improved

- **Modals and editor header.** Modals animate in and out, and the editor header is laid out in two rows. [#ff279e2](https://github.com/MemloreApp/memlore/commit/ff279e2)

### Fixed

- **Web edit import.** Importing edits made on the web is more reliable, with a Drive ETag fallback and friendlier sync steps. [#fee6c78](https://github.com/MemloreApp/memlore/commit/fee6c78)
- **Entry cards.** Covers no longer jump while loading, the page shows a skeleton, and orphaned media is adopted. [#c5380e4](https://github.com/MemloreApp/memlore/commit/c5380e4)
- **Title and device removal.** Entry title and device removal edge cases are fixed. [#ff279e2](https://github.com/MemloreApp/memlore/commit/ff279e2)

### Internal

- Pruned the test suite to tests that protect sync, security, migrations and frozen formats, and pinned the clock in the golden desktop fixture test. [#fbe27d2](https://github.com/MemloreApp/memlore/commit/fbe27d2) [#67d41d2](https://github.com/MemloreApp/memlore/commit/67d41d2) [#90d828b](https://github.com/MemloreApp/memlore/commit/90d828b) [#328f11f](https://github.com/MemloreApp/memlore/commit/328f11f) [#a448a1b](https://github.com/MemloreApp/memlore/commit/a448a1b) [#45cd932](https://github.com/MemloreApp/memlore/commit/45cd932) [#5f20862](https://github.com/MemloreApp/memlore/commit/5f20862) [#e8796cb](https://github.com/MemloreApp/memlore/commit/e8796cb) [#2524c09](https://github.com/MemloreApp/memlore/commit/2524c09) [#cc911e2](https://github.com/MemloreApp/memlore/commit/cc911e2) [#2471b33](https://github.com/MemloreApp/memlore/commit/2471b33) [#e5583af](https://github.com/MemloreApp/memlore/commit/e5583af)
- Repository links now point to `MemloreApp/memlore`. [#39ac9e2](https://github.com/MemloreApp/memlore/commit/39ac9e2)

## web-v0.2.0 (2026-10-11)

### Added

- **Write from the web (behind a flag).** Create entries, journals, tags and templates, and move entries to the Trash, through the encrypted outbox v2 that the desktop imports on its next sync. Includes web wire fields, write readiness and translated outbox notices. Shipped with the flag off (`WEB_WRITES_ENABLED = "0"` in `workers/web-auth/wrangler.toml`), so users saw read-only mode until web-v0.2.1 turned it on. [#b0e04dd](https://github.com/MemloreApp/memlore/commit/b0e04dd) [#78157d8](https://github.com/MemloreApp/memlore/commit/78157d8)
- **More views from the month index.** Gallery, On this day, Map, Stats and version history. [#cf2e647](https://github.com/MemloreApp/memlore/commit/cf2e647)
- **Read-only chats, memory, persona and streak.** Single-entry Markdown export. [#c8dff89](https://github.com/MemloreApp/memlore/commit/c8dff89)
- **Read-only mode, Home, Cmd+S and Markdown export.** Home on the web, Cmd+S saves, and the Markdown export is richer. [#bccf9ff](https://github.com/MemloreApp/memlore/commit/bccf9ff)
- **Idle auto-lock.** The vault locks after idle time, unlock survives reloads, and a removed-browser screen explains a revoked browser. [#d781c7e](https://github.com/MemloreApp/memlore/commit/d781c7e)
- **Read-only Trash.** A Recently deleted shortcut in the footer. [#12e9c51](https://github.com/MemloreApp/memlore/commit/12e9c51)

### Improved

- **Sync status.** Explains pending work and the first load, with an icon-only footer status. [#8174747](https://github.com/MemloreApp/memlore/commit/8174747)
- **Modals and editor header.** Animated modals and a two-row editor header. [#ff279e2](https://github.com/MemloreApp/memlore/commit/ff279e2)

### Fixed

- **Edit import and Drive reads.** More reliable web edit import with a Drive ETag fallback. [#fee6c78](https://github.com/MemloreApp/memlore/commit/fee6c78)
- **Entry cards.** Stable covers and page skeleton. [#c5380e4](https://github.com/MemloreApp/memlore/commit/c5380e4)
- **Browser tab title.** Set to "Memlore Web (beta)". [#4a26a94](https://github.com/MemloreApp/memlore/commit/4a26a94)
- **Clay on unsupported pages.** They are painted with the editor panel. [#c76f44a](https://github.com/MemloreApp/memlore/commit/c76f44a)

## v0.2.2 (2026-10-06)

### Added

- **Repair sync from this device.** The recovery wizard can publish entries and
  journals that live on this Mac and that no other device owns, including
  journals that never had an owner, so they upload on the next sync. Nothing is
  deleted on this device or in the cloud.
  [#6ce1249](https://github.com/dinhanhthi/memlore/commit/6ce1249)
  [#4710b94](https://github.com/dinhanhthi/memlore/commit/4710b94)
- **Desktop imports edits made in Memlore Web.** Sync discovers the companion's
  sealed outbox and merges those edits and new entries into the local journal.
  The desktop copy wins conflicts. An intent this Mac has already refused is
  not imported again on every cycle.
  [#7b0d1cf](https://github.com/dinhanhthi/memlore/commit/7b0d1cf)
  [#45a44c8](https://github.com/dinhanhthi/memlore/commit/45a44c8)
  [#2a6b9e3](https://github.com/dinhanhthi/memlore/commit/2a6b9e3)

### Improved

- **Home AI cards.** Insights and related list cards use an orb loader and a
  tighter list, with padding around a hovered row.
  [#829673d](https://github.com/dinhanhthi/memlore/commit/829673d)
  [#bcd0768](https://github.com/dinhanhthi/memlore/commit/bcd0768)

### Notes for maintainers

- Envelope crypto and payload framing live in `memlore-core`, with
  `memlore-wasm` bindings for the web companion. An outbox seal rejects an
  oversized input.
  [#5ade521](https://github.com/dinhanhthi/memlore/commit/5ade521)
  [#de7f962](https://github.com/dinhanhthi/memlore/commit/de7f962)
  [#d2e0c29](https://github.com/dinhanhthi/memlore/commit/d2e0c29)
  [#59a20e8](https://github.com/dinhanhthi/memlore/commit/59a20e8)
  [#a619b7c](https://github.com/dinhanhthi/memlore/commit/a619b7c)

## web-v0.1.1 (2026-10-06)

### Added

- **Google account in Sync settings.** Shows the signed-in Drive email and how
  much storage is free.
  [#d6e55b2](https://github.com/dinhanhthi/memlore/commit/d6e55b2)

### Improved

- **Faster open and refresh.** A cached entry list shows immediately while
  Drive revalidates, per-device reads run in parallel, and folder ids are
  remembered so the first refresh lists less.
  [#b29ed43](https://github.com/dinhanhthi/memlore/commit/b29ed43)
  [#2f5bd04](https://github.com/dinhanhthi/memlore/commit/2f5bd04)
  [#ff117d1](https://github.com/dinhanhthi/memlore/commit/ff117d1)
- **Memlore Web explains itself.** The header uses that name, pages the browser
  cannot do show a short placeholder, and About lists what the companion can
  and cannot do. A password-mode mismatch tells you to fix it on the desktop
  app.
  [#0755ac8](https://github.com/dinhanhthi/memlore/commit/0755ac8)
  [#3539b37](https://github.com/dinhanhthi/memlore/commit/3539b37)
  [#0b0bbdb](https://github.com/dinhanhthi/memlore/commit/0b0bbdb)
  [#92fe0fd](https://github.com/dinhanhthi/memlore/commit/92fe0fd)

### Fixed

- **The editor stays read-only when web writes are off.**
  [#1bfaf24](https://github.com/dinhanhthi/memlore/commit/1bfaf24)
- **Entry cards no longer offer delete.**
  [#f001458](https://github.com/dinhanhthi/memlore/commit/f001458)
- **Google sign-in no longer opens a second page** after the Drive popup.
  [#f6bf265](https://github.com/dinhanhthi/memlore/commit/f6bf265)
  [#9e8d49d](https://github.com/dinhanhthi/memlore/commit/9e8d49d)

## web-v0.1.0 (2026-10-05)

First release of the web companion at web.memlore.app. It opens an existing desktop vault in the browser; creating a vault stays on the desktop.

### Added

- **Open your vault in the browser.** Sign in with Google, enter the 24-word recovery phrase, and choose a web password. The browser registers as its own device, which desktop can remove from Settings → Security. Keys live in WebAssembly memory; IndexedDB holds only ciphertext.
- **Lazy reads from Google Drive.** The five newest entries load first, older ones on demand, and media when an entry is opened. A media cache keeps ciphertext only and cleans itself up.
- **Edits through an outbox.** The web never writes sync files. Edits (content, title, date, emotion, favorite, journal, tags, photos and videos) are sealed into the browser's own `outbox/` folder, and the desktop imports and merges them with its own sync code. Desktop wins conflicts, and nothing is ever deleted from the web. Writes are behind the `WEB_WRITES_ENABLED` switch and start off.
- **Desktop outbox importer.** Desktop sync discovers and imports those outbox edits and creations, merging Yjs documents without clock comparisons, and publishes its decisions so the web stops re-sending them.
- **Safety checks before every write.** The recovery fence, an unknown-format latch that turns the web read-only, a clock-skew limit, and seal-then-verify of every payload.
- **Pending edits from other browsers** show in the overlay, read-only, before desktop imports them.

### Notes for maintainers

- Version in `web/version.json`; tags are `web-v*` and deploy through `deploy-web.yml`. No GitHub Release is created for a web tag.
- The OAuth Worker (`workers/web-auth`) only exchanges the Google code. There is no Memlore data server.

## v0.2.1 (2026-10-01)

### Added

- **Story numbers on Statistics and the home dashboard.** The Charts tab opens with six tiles for the selected period: entries, words, day streak, mood split, days written this year, and the hour you write most, each with a small chart. Home cards use the same charts and tone chips, with more padding and an icon beside each title. [#d9a1b33](https://github.com/MemloreApp/memlore/commit/d9a1b33) [#6e0c7ab](https://github.com/MemloreApp/memlore/commit/6e0c7ab) [#3eec79f](https://github.com/MemloreApp/memlore/commit/3eec79f) [#a59815b](https://github.com/MemloreApp/memlore/commit/a59815b) [#1e6c8bf](https://github.com/MemloreApp/memlore/commit/1e6c8bf)
- **Desktop outbox importer for companion web writes.** Desktop sync cycles automatically discover and import encrypted outbox edits and creations from companion devices, merging Yjs entry documents and field changes without clock skew.

### Notes for maintainers

- Dev Cargo builds stay smaller; `scripts/tauri.sh` keeps the release bundle profile in-repo. [#67f482a](https://github.com/MemloreApp/memlore/commit/67f482a)

## v0.2.0 (2026-09-21)

### Added

- **Local MCP server.** Opt-in under Settings → AI (off by default; a confirmation acknowledges that any app running as you on this Mac can read and write the decrypted journal). Desktop MCP clients reach six journal tools (`list_journals`, `search_entries`, `get_entry`, `create_entry`, `append_to_entry`, `set_entry_metadata`) over a local Unix socket via a stdio bridge. Settings shows a copy-paste Claude Desktop snippet from the running binary path, a default-journal picker, and a running status; the editor refreshes when a client writes the open entry. Works without an AI provider. [#025980f](https://github.com/MemloreApp/memlore/commit/025980f) [#8b79a17](https://github.com/MemloreApp/memlore/commit/8b79a17) [#b31390c](https://github.com/MemloreApp/memlore/commit/b31390c) [#2dbee85](https://github.com/MemloreApp/memlore/commit/2dbee85) [#639cc27](https://github.com/MemloreApp/memlore/commit/639cc27) [#8b129e5](https://github.com/MemloreApp/memlore/commit/8b129e5)

### Fixed

- **Clay sidebar nav hover.** Restored the hover rule dropped in `5955fad`. [#54a8c0d](https://github.com/MemloreApp/memlore/commit/54a8c0d)

## v0.1.1 (2026-09-18)

### Fixed

- **Updates install in the background instead of freezing the app.** The updater no longer blocks the UI while downloading; a new `UpdateReadyCard` prompts to restart once the install is ready, and release notes render as markdown instead of raw text. [#d81b365](https://github.com/MemloreApp/memlore/commit/d81b365)

### Improved

- **About panel.** Author, website, license and GitHub links are current, and the tagline/version layout is tighter. [#c114a03](https://github.com/MemloreApp/memlore/commit/c114a03) [#828290b](https://github.com/MemloreApp/memlore/commit/828290b)

## v0.1.0 (2026-09-18)

First signed public release. There is no previous version to diff against, so this section describes what ships rather than what changed.

### Added

- **Signed, notarized macOS builds.** Universal binary (`x86_64` + `arm64`), signed with a Developer ID certificate and notarized through App Store Connect, published as a `.dmg` from CI on a `v*` tag. Requires macOS 13. [#7632d80](https://github.com/MemloreApp/memlore/commit/7632d80) [#756ff1f](https://github.com/MemloreApp/memlore/commit/756ff1f)
- **In-app updater** with two channels. `Memlore > Check For Updates…` checks on demand; an automatic check runs once per launch and can be turned off in Settings → General. The **Beta** channel opts into prereleases. Update archives are verified against a minisign public key compiled into the app, so a tampered download is rejected rather than installed. [#7fce287](https://github.com/MemloreApp/memlore/commit/7fce287) [#ee8dbd4](https://github.com/MemloreApp/memlore/commit/ee8dbd4)
- **Touch ID unlock** — the `keychain-access-groups` entitlement and a Developer ID provisioning profile are embedded at bundle time, which is what makes `BIOMETRY_CURRENT_SET` usable in a distributed build. [#7632d80](https://github.com/MemloreApp/memlore/commit/7632d80)

### Notes for maintainers

- The updater's minisign keypair **cannot be rotated** after this release: its public half is compiled into every shipped binary and Tauri's updater has no in-band key rotation. See `.github/release-setup.md`.
- `bundle.createUpdaterArtifacts` is on, so any local `tauri build` needs either `TAURI_SIGNING_PRIVATE_KEY` or `--no-sign`. `CONTRIBUTING.md` covers this.
- An expired embedded provisioning profile makes the app unlaunchable for every user, not just degraded. `release.yml` refuses to build when under 30 days remain, and rejects a Mac Development profile outright.
