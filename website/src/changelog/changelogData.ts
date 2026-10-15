/**
 * User-facing release notes for the website. The developer-facing counterpart is
 * the repository's CHANGELOG.md — this file is the plain-language retelling for
 * people who just want to know what changed in the app they use. No commit
 * hashes, no file paths, no internal identifiers.
 */

export type ChangelogKind = 'new' | 'improved' | 'fixed' | 'breaking'

/** The desktop app (`v*` tags) or the web companion (`web-v*` tags). Each has its own versions. */
export type ChangelogPlatform = 'mac' | 'web'

export type ChangelogItem = {
  kind: ChangelogKind
  text: string
}

export type ChangelogRelease = {
  /** Bare semver, no leading `v` — the badge and headings add it. */
  version: string
  /** ISO `YYYY-MM-DD`, rendered in UTC so the day never shifts. */
  date: string
  /** `false` marks a prerelease; it is shown with a Beta marker and never becomes `latestStableVersion`. */
  stable: boolean
  /** Absent means `'mac'`: every release before the web companion was the desktop app. */
  platform?: ChangelogPlatform
  items: ChangelogItem[]
}

/** Newest release first. */
export const releases: ChangelogRelease[] = [
  {
    version: '0.2.5',
    date: '2026-10-15',
    stable: true,
    items: [
      {
        kind: 'new',
        text: 'This Mac now brings in more of the edits you make in Memlore Web, including memories, personas, locations and attachments.',
      },
      {
        kind: 'fixed',
        text: 'Imported entries now sync to your other devices, and edits made on the web come through cleanly.',
      },
      {
        kind: 'fixed',
        text: 'Tag colors are kept, the Cancel button in confirmation dialogs is translated, and the location, version history and Trash count look tidier.',
      },
    ],
  },
  {
    version: '0.2.2',
    date: '2026-10-15',
    stable: true,
    platform: 'web',
    items: [
      {
        kind: 'new',
        text: 'You can now edit and delete more in Memlore Web: journals, tags, Trash, memories, personas, locations and attachments.',
      },
      {
        kind: 'improved',
        text: 'Memlore Web fits within your browser storage limits, stays unlocked across tabs, and tells you clearly when your browser is not supported.',
      },
      {
        kind: 'fixed',
        text: 'Attached PDFs now open, and edits made on the web reach your desktop more reliably.',
      },
      {
        kind: 'fixed',
        text: 'Tag colors are kept, the Cancel button in confirmation dialogs is translated, and the location, version history and Trash count look tidier.',
      },
    ],
  },
  {
    version: '0.2.1',
    date: '2026-10-11',
    stable: true,
    platform: 'web',
    items: [
      {
        kind: 'new',
        text: 'You can now write in Memlore Web: write, edit and delete entries, create journals and tags, and create or edit templates. Your desktop brings the changes in the next time it syncs.',
      },
      {
        kind: 'fixed',
        text: 'Messages about updating the desktop app now ask for the right version, Memlore 0.2.3 or later.',
      },
    ],
  },
  {
    version: '0.2.3',
    date: '2026-10-11',
    stable: true,
    items: [
      {
        kind: 'new',
        text: 'Deleted entries now go to a Recently deleted tab, so you can bring them back. Emptying an entry from there is synced to your other devices.',
      },
      {
        kind: 'new',
        text: 'This Mac can now bring in journals, tags and templates created in Memlore Web, and entries moved to the Trash there.',
      },
      {
        kind: 'improved',
        text: 'The sync status in the footer is now a small icon, and it explains what is still waiting to sync.',
      },
      {
        kind: 'improved',
        text: 'Dialogs open and close with a smooth animation, and the editor header is tidier.',
      },
      {
        kind: 'fixed',
        text: 'Importing edits from Memlore Web is more reliable, and entry cards no longer jump around while they load.',
      },
    ],
  },
  {
    version: '0.2.0',
    date: '2026-10-11',
    stable: true,
    platform: 'web',
    items: [
      {
        kind: 'new',
        text: 'Writing from the web arrived in this version: creating entries, journals, tags and templates and moving entries to the trash, picked up by your desktop on its next sync. It shipped switched off and was turned on in Web 0.2.1.',
      },
      {
        kind: 'new',
        text: 'Browse your journal in more ways: a gallery, On this day, a map, stats and version history for each entry.',
      },
      {
        kind: 'new',
        text: 'Read your chats, memory, persona and streak on the web, and export a single entry as Markdown.',
      },
      {
        kind: 'new',
        text: 'Memlore Web locks itself when you are idle, and it stays unlocked across page reloads.',
      },
      {
        kind: 'improved',
        text: 'Home and Cmd+S to save are available on the web, and sync explains what it is doing, including the first load.',
      },
      {
        kind: 'fixed',
        text: 'Pages that are not supported on the web yet look right in the Clay theme, and the browser tab is titled Memlore Web (beta).',
      },
    ],
  },
  {
    version: '0.2.2',
    date: '2026-10-06',
    stable: true,
    items: [
      {
        kind: 'new',
        text: 'If entries or journals are on this Mac but missing on your other devices or on the web, Settings → Sync can repair from this device. It publishes what no other device owns so the next sync uploads it, and nothing is deleted.',
      },
      {
        kind: 'new',
        text: 'Edits and new entries you make in Memlore Web are imported the next time this Mac syncs. If the same thing changed in both places, this Mac wins.',
      },
      {
        kind: 'improved',
        text: 'Home AI cards load with a softer animation and a cleaner list, with a little more space when you hover a row.',
      },
    ],
  },
  {
    version: '0.1.1',
    date: '2026-10-06',
    stable: true,
    platform: 'web',
    items: [
      {
        kind: 'improved',
        text: 'Memlore Web opens faster. Entries you have already loaded appear right away, and refreshing from Google Drive takes less time.',
      },
      {
        kind: 'new',
        text: 'Sync settings show the Google account you are signed in with and how much Drive storage is left.',
      },
      {
        kind: 'improved',
        text: 'The app introduces itself as Memlore Web. Pages it cannot do, such as the dashboard and statistics, explain that instead of opening empty, and About lists what the web version can and cannot do.',
      },
      {
        kind: 'fixed',
        text: 'When editing on the web is turned off, the editor stays read-only, entry cards no longer offer delete, and signing in with Google no longer opens an extra browser window after the popup.',
      },
    ],
  },
  {
    version: '0.1.0',
    date: '2026-10-05',
    stable: true,
    platform: 'web',
    items: [
      {
        kind: 'new',
        text: 'Memlore Web: open your journal in any browser. Sign in with Google, enter your recovery phrase, and read and search your entries and media. Your keys stay in your browser and nothing goes through a Memlore server. You create your vault on the desktop first.',
      },
      {
        kind: 'new',
        text: 'Edits made on the web are saved to a private outbox on your Google Drive, and your desktop app merges them on its next sync. If you change the same thing on both, your desktop wins, and the web never deletes anything. Editing on the web is switched on separately and starts off.',
      },
    ],
  },
  {
    version: '0.2.1',
    date: '2026-10-01',
    stable: true,
    items: [
      {
        kind: 'new',
        text: 'Statistics and Home now open with a story in numbers: how many entries and words you wrote, your streak, your mood, the days you showed up this year, and the hour you usually write. Each number has a small chart for the period you pick, and home cards use the same style with an icon next to the title.',
      },
    ],
  },
  {
    version: '0.2.0',
    date: '2026-09-21',
    stable: true,
    items: [
      {
        kind: 'new',
        text: 'Let other apps on your Mac read and write your journal through MCP. Turn it on in Settings → AI, paste the config into Claude Desktop or another MCP client, and they can list journals, search and open entries, and create or update them. It stays off until you say yes, and it works even if you have not set up an AI provider.',
      },
      {
        kind: 'fixed',
        text: 'Clay’s sidebar navigation highlights again when you hover an item.',
      },
    ],
  },
  {
    version: '0.1.1',
    date: '2026-09-18',
    stable: true,
    items: [
      {
        kind: 'fixed',
        text: 'Updates no longer freeze the app while installing. Memlore downloads and installs in the background, then asks you to restart when it is ready, and shows the release notes properly formatted.',
      },
      {
        kind: 'improved',
        text: 'Refreshed the About panel with current author, website and license info.',
      },
    ],
  },
  {
    version: '0.1.0',
    date: '2026-09-18',
    stable: true,
    items: [
      {
        kind: 'new',
        text: 'First public release. A private journal on your Mac, with signed updates, a Beta channel, and Touch ID unlock. Requires macOS 13 or later.',
      },
    ],
  },
]

/**
 * Exported for the test that proves a prerelease can never reach the badge: with
 * a beta bump sitting at the top of `releases`, the public site must still show
 * the last stable version.
 */
export function platformOf(release: ChangelogRelease): ChangelogPlatform {
  return release.platform ?? 'mac'
}

/** The site badge is the downloadable desktop app: web releases never reach it. */
export function latestStableReleaseOf(entries: ChangelogRelease[]): ChangelogRelease {
  const stable = entries.find((entry) => entry.stable && platformOf(entry) === 'mac')
  if (!stable) throw new Error('changelogData: no stable release to show')
  return stable
}

export function latestStableVersionOf(entries: ChangelogRelease[]): string {
  return latestStableReleaseOf(entries).version
}

export const latestStableRelease = latestStableReleaseOf(releases)
export const latestStableVersion = latestStableRelease.version

/** The web companion's newest stable version, shown on the landing page's Web row. */
const latestStableWebRelease = releases.find((entry) => entry.stable && platformOf(entry) === 'web')
if (!latestStableWebRelease) throw new Error('changelogData: no stable web release to show')
export const latestStableWebVersion = latestStableWebRelease.version

/** The release's tag: `v0.2.1` for the desktop app, `web-v0.1.0` for the web companion. */
export function releaseAnchorId(release: ChangelogRelease): string {
  return `${platformOf(release) === 'web' ? 'web-' : ''}v${release.version}`
}
