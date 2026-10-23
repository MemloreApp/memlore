/**
 * Captures the landing page screenshots from the demo into `website/src/screenshots/`.
 * Needs `pnpm website:dev` running and `cwebp` on the PATH; see website/README.md.
 *
 *   node --experimental-strip-types website/scripts/screenshots.ts [http://localhost:5177]
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Page } from '@playwright/test'

type Look = { system: 'Clay' | 'Clean' | 'Signature'; mode: 'Light' | 'Dark' }

// The website tsconfig types `process` as Vite's browser shim, so read argv untyped.
const { argv } = (globalThis as unknown as { process: { argv: string[] } }).process
const origin = argv[2] ?? 'http://localhost:5177'
const OUT_DIR = fileURLToPath(new URL('../src/screenshots/', import.meta.url))

const clayDark: Look = { system: 'Clay', mode: 'Dark' }
const clayLight: Look = { system: 'Clay', mode: 'Light' }
const cleanLight: Look = { system: 'Clean', mode: 'Light' }
const signatureDark: Look = { system: 'Signature', mode: 'Dark' }
const signatureLight: Look = { system: 'Signature', mode: 'Light' }

const nav = (page: Page, label: string) =>
  page
    .getByRole('button', { name: label, exact: true })
    .or(page.getByRole('link', { name: label, exact: true }))
    .first()
    .click()
const text = (page: Page, label: string) => page.getByText(label, { exact: true }).first().click()

// Order is the order on the page; ids match `landing.screenshots.items` in en.ts.
// Most seeded entries have no body; "A fresh start", "Arrived in Lisbon" and
// "Sintra day trip" do, so the editor shots use those.
const SHOTS: { id: string; look: Look; act: (page: Page) => Promise<unknown> }[] = [
  { id: 'write', look: clayDark, act: async () => {} },
  {
    id: 'search',
    look: clayDark,
    act: async (p) => {
      await p.keyboard.press('Meta+k')
      await p.waitForTimeout(600)
      await p.keyboard.type('coffee')
    },
  },
  { id: 'home', look: clayDark, act: (p) => nav(p, 'Home') },
  {
    id: 'calendar',
    look: cleanLight,
    act: async (p) => {
      await nav(p, 'Calendar')
      const sintra = new Date(Date.now() - 9 * 86_400_000) // daysAgo(9) in mockup/fixtures
      if (sintra.getMonth() !== new Date().getMonth()) await nav(p, 'Previous month')
      await p.getByRole('button', { name: new RegExp(`^${sintra.getDate()} `) }).click()
      await text(p, 'Sintra day trip')
    },
  },
  { id: 'gallery', look: cleanLight, act: (p) => nav(p, 'Gallery') },
  {
    id: 'lock',
    look: cleanLight,
    act: (p) => nav(p, 'Lock app'),
  },
  {
    id: 'tags',
    look: signatureDark,
    act: async (p) => {
      await nav(p, 'Tags')
      await text(p, 'gratitude')
      await text(p, 'Arrived in Lisbon')
    },
  },
  { id: 'stats', look: signatureDark, act: (p) => nav(p, 'Statistics') },
  {
    id: 'chat',
    look: signatureDark,
    act: async (p) => {
      await nav(p, 'Chat')
      await text(p, 'Morning reflections')
    },
  },
  {
    id: 'focus',
    look: signatureDark,
    act: async (p) => {
      await nav(p, 'Entries')
      await text(p, 'A fresh start')
      await nav(p, 'Enable distraction free mode')
    },
  },
  {
    id: 'appearance',
    look: signatureLight,
    act: async (p) => {
      await nav(p, 'Settings')
      await text(p, 'Appearance')
    },
  },
  {
    id: 'sync',
    look: clayLight,
    act: async (p) => {
      await nav(p, 'Settings')
      await text(p, 'Sync')
    },
  },
  {
    id: 'locks',
    look: clayLight,
    act: async (p) => {
      await nav(p, 'Settings')
      await text(p, 'Security')
      await text(p, 'Second lock')
    },
  },
  {
    id: 'data',
    look: clayDark,
    act: async (p) => {
      await nav(p, 'Settings')
      await text(p, 'Data')
    },
  },
]

async function applyLook(page: Page, look: Look) {
  if (look.system === 'Clay' && look.mode === 'Dark') return // the demo's seeded default
  await nav(page, 'Settings')
  await text(page, 'Appearance')
  await text(page, look.system)
  await text(page, look.mode)
}

const work = mkdtempSync(join(tmpdir(), 'memlore-shots-'))
const browser = await chromium.launch()
try {
  for (const shot of SHOTS) {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 2,
    })
    await page.goto(`${origin}/demo.html`, { waitUntil: 'networkidle' })
    await page.waitForTimeout(2500)
    await applyLook(page, shot.look)
    await shot.act(page)
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(2000)
    // "This action is simulated" toasts would sit on top of the shot.
    for (const dismiss of await page.getByRole('button', { name: 'Dismiss' }).all()) {
      await dismiss.click()
    }
    const png = join(work, `${shot.id}.png`)
    await page.screenshot({ path: png })
    await page.close()
    const webp = (suffix: string, width: number, quality: number) =>
      execFileSync('cwebp', [
        '-quiet',
        '-q',
        String(quality),
        '-m',
        '6',
        '-resize',
        String(width),
        '0',
        png,
        '-o',
        join(OUT_DIR, `${shot.id}${suffix}.webp`),
      ])
    webp('', 1800, 75)
    webp('-thumb', 560, 70)
    console.log(`captured ${shot.id}`)
  }
} finally {
  await browser.close()
  rmSync(work, { recursive: true, force: true })
}
