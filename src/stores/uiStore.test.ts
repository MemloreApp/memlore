import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  DEFAULT_CORNER_RADIUS,
  DEFAULT_DESIGN_SYSTEM,
  DEFAULT_SURFACE_STYLE,
} from '../lib/designSystem'
import {
  coerceDataTab,
  coerceTheme,
  DEFAULT_THEME,
  getEntryListFilter,
  REMOVED_DEVICE_HIDE_MS,
  useUiStore,
  validDataTabs,
} from './uiStore'

// matchMedia is not available in jsdom — provide a default stub that reports
// OS preference as 'light' (matches: false for the dark query).
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
})

// Reset store state before each test. Clear localStorage so Zustand persist
// can't bleed values from a prior test into the next one.
beforeEach(() => {
  globalThis.localStorage.clear()
  useUiStore.setState({
    sidebarCollapsed: false,
    theme: DEFAULT_THEME,
    designSystem: DEFAULT_DESIGN_SYSTEM,
    surfaceStyle: DEFAULT_SURFACE_STYLE,
    cornerRadius: DEFAULT_CORNER_RADIUS,
    searchOverlayOpen: false,
    reducedMotion: false,
    uiLanguage: 'en',
    timeFormat: '24h',
    newEntryMode: 'blank',
    updateChannel: 'stable',
    autoCheckUpdates: true,
    syncFooterIconOnly: false,
    rotationBusy: false,
    deviceRenameBusy: false,
    deviceRemovalBusy: false,
    deviceRemovalOutcome: null,
    entryListFilters: {},
    pendingOpenPresetId: null,
    addedProviders: [],
  })
})

describe('uiStore', () => {
  describe('coerceTheme', () => {
    it('keeps light and dark', () => {
      expect(coerceTheme('light')).toBe('light')
      expect(coerceTheme('dark')).toBe('dark')
    })

    it('maps system and unknown values to dark', () => {
      expect(coerceTheme('system')).toBe('dark')
      expect(coerceTheme('auto')).toBe('dark')
      expect(coerceTheme(undefined)).toBe('dark')
    })
  })

  describe('persistence', () => {
    // Lock the partialized subset down: searchOverlayOpen must NOT be persisted
    // (overlay would reopen every launch). reducedMotion MUST be persisted so
    // the user's explicit preference survives restarts.
    // Settings/stats nav lives on per-tab Tab in tabStore — not in memlore-ui.
    it('persists sidebarCollapsed, theme, reducedMotion, uiLanguage, and timeFormat (not searchOverlayOpen or settings nav)', () => {
      useUiStore.setState({
        sidebarCollapsed: true,
        theme: 'dark',
        searchOverlayOpen: true,
        reducedMotion: true,
        timeFormat: '12h',
      })
      const persisted = JSON.parse(globalThis.localStorage.getItem('memlore-ui') ?? '{}') as {
        state?: Record<string, unknown>
      }
      expect(persisted.state).toEqual({
        sidebarCollapsed: true,
        theme: 'dark',
        designSystem: DEFAULT_DESIGN_SYSTEM,
        surfaceStyle: 'deep',
        cornerRadius: DEFAULT_CORNER_RADIUS,
        reducedMotion: true,
        disableGradientPrimary: false,
        logoFollowsCursor: false,
        uiFontScale: 1,
        mediaPageSize: 20,
        uiLanguage: 'en',
        timeFormat: '12h',
        newEntryMode: 'blank',
        updateChannel: 'stable',
        autoCheckUpdates: true,
        syncFooterIconOnly: false,
        addedProviders: [],
      })
      // Orphaned settings-nav keys from older releases must not reappear.
      expect(persisted.state).not.toHaveProperty('settingsCategory')
      expect(persisted.state).not.toHaveProperty('statsTab')
      expect(persisted.state).not.toHaveProperty('securityTab')
    })

    it('coerceDataTab keeps demo only in DEV builds', () => {
      expect(validDataTabs(true)).toEqual(['import', 'export', 'downloads', 'trash', 'demo'])
      expect(validDataTabs(false)).toEqual(['import', 'export', 'downloads', 'trash'])
      expect(coerceDataTab('trash', false)).toBe('trash')
      expect(coerceDataTab('trash', true)).toBe('trash')
      // Persisted state is untrusted: a non-string must coerce, not throw.
      expect(coerceDataTab(42, false)).toBe('import')
      expect(coerceDataTab(undefined, false)).toBe('import')
      expect(coerceDataTab('demo', true)).toBe('demo')
      expect(coerceDataTab('demo', false)).toBe('import')
      expect(coerceDataTab('export', false)).toBe('export')
      expect(coerceDataTab('downloads', true)).toBe('downloads')
      expect(coerceDataTab('downloads', false)).toBe('downloads')
      expect(coerceDataTab('qux', true)).toBe('import')
    })

    it('rehydrate snaps an out-of-catalog mediaPageSize back to the default', async () => {
      // `mediaPageSize` flows untrusted into the backend LIMIT. A stale or
      // corrupted persisted value (0, NaN, a removed option) must not reach
      // the SQL — the merge step snaps anything outside 12/20/40/60 to 20.
      globalThis.localStorage.setItem(
        'memlore-ui',
        JSON.stringify({
          state: { mediaPageSize: 999 },
          version: 0,
        }),
      )

      await useUiStore.persist.rehydrate()
      expect(useUiStore.getState().mediaPageSize).toBe(20)

      globalThis.localStorage.setItem(
        'memlore-ui',
        JSON.stringify({
          state: { mediaPageSize: 40 },
          version: 0,
        }),
      )

      await useUiStore.persist.rehydrate()
      expect(useUiStore.getState().mediaPageSize).toBe(40)
    })
  })

  describe('uiFontScale', () => {
    it('rehydrate coerces an unknown uiFontScale back to 1', async () => {
      globalThis.localStorage.setItem(
        'memlore-ui',
        JSON.stringify({
          state: { uiFontScale: 2.5 }, // unknown / legacy value
          version: 0,
        }),
      )

      await useUiStore.persist.rehydrate()

      expect(useUiStore.getState().uiFontScale).toBe(1)
    })

    it('rehydrate coerces an unknown newEntryMode back to blank', async () => {
      globalThis.localStorage.setItem(
        'memlore-ui',
        JSON.stringify({
          state: { newEntryMode: 'garbage' },
          version: 0,
        }),
      )

      await useUiStore.persist.rehydrate()

      expect(useUiStore.getState().newEntryMode).toBe('blank')
    })

    it('rehydrate coerces an unknown updateChannel back to stable', async () => {
      globalThis.localStorage.setItem(
        'memlore-ui',
        JSON.stringify({
          state: { updateChannel: 'nightly' },
          version: 0,
        }),
      )

      await useUiStore.persist.rehydrate()

      expect(useUiStore.getState().updateChannel).toBe('stable')
    })

    it('rehydrate coerces a non-boolean autoCheckUpdates back to on', async () => {
      globalThis.localStorage.setItem(
        'memlore-ui',
        JSON.stringify({
          state: { autoCheckUpdates: 'off' },
          version: 0,
        }),
      )

      await useUiStore.persist.rehydrate()

      expect(useUiStore.getState().autoCheckUpdates).toBe(true)
    })

    it('rehydrate keeps a deliberate autoCheckUpdates opt-out', async () => {
      globalThis.localStorage.setItem(
        'memlore-ui',
        JSON.stringify({
          state: { autoCheckUpdates: false },
          version: 0,
        }),
      )

      await useUiStore.persist.rehydrate()

      expect(useUiStore.getState().autoCheckUpdates).toBe(false)
    })
  })

  describe('syncFooterIconOnly rehydrate', () => {
    it('defaults to off when an older build persisted no value', async () => {
      globalThis.localStorage.setItem('memlore-ui', JSON.stringify({ state: {}, version: 0 }))

      await useUiStore.persist.rehydrate()

      expect(useUiStore.getState().syncFooterIconOnly).toBe(false)
    })

    it('coerces a non-boolean value back to off', async () => {
      globalThis.localStorage.setItem(
        'memlore-ui',
        JSON.stringify({ state: { syncFooterIconOnly: 'yes' }, version: 0 }),
      )

      await useUiStore.persist.rehydrate()

      expect(useUiStore.getState().syncFooterIconOnly).toBe(false)
    })

    it('keeps a deliberate opt-in', async () => {
      globalThis.localStorage.setItem(
        'memlore-ui',
        JSON.stringify({ state: { syncFooterIconOnly: true }, version: 0 }),
      )

      await useUiStore.persist.rehydrate()

      expect(useUiStore.getState().syncFooterIconOnly).toBe(true)
    })
  })

  describe('designSystem', () => {
    it("rehydrate coerces an unknown designSystem ('shadcn-v2') back to the default", async () => {
      globalThis.localStorage.setItem(
        'memlore-ui',
        JSON.stringify({
          state: { designSystem: 'shadcn-v2' },
          version: 0,
        }),
      )

      await useUiStore.persist.rehydrate()

      expect(useUiStore.getState().designSystem).toBe(DEFAULT_DESIGN_SYSTEM)
    })

    it("rehydrate maps leftover designSystem 'lumen' to signature + surfaceStyle lumen", async () => {
      globalThis.localStorage.setItem(
        'memlore-ui',
        JSON.stringify({
          state: { designSystem: 'lumen' },
          version: 0,
        }),
      )

      await useUiStore.persist.rehydrate()

      expect(useUiStore.getState().designSystem).toBe('signature')
      expect(useUiStore.getState().surfaceStyle).toBe('lumen')

      // onRehydrateStorage mutates in place; persist writes on the next set().
      useUiStore.setState({})
      const persisted = JSON.parse(globalThis.localStorage.getItem('memlore-ui') ?? '{}') as {
        state?: Record<string, unknown>
      }
      expect(persisted.state?.designSystem).toBe('signature')
      expect(persisted.state?.surfaceStyle).toBe('lumen')
    })
  })

  describe('surfaceStyle', () => {
    it("rehydrate coerces a missing surfaceStyle back to 'deep'", async () => {
      globalThis.localStorage.setItem(
        'memlore-ui',
        JSON.stringify({
          state: { designSystem: 'signature' },
          version: 0,
        }),
      )

      await useUiStore.persist.rehydrate()

      expect(useUiStore.getState().surfaceStyle).toBe('deep')
    })
  })

  describe('cornerRadius', () => {
    it("rehydrate coerces a garbage value ('HIGH') to 'high'", async () => {
      globalThis.localStorage.setItem(
        'memlore-ui',
        JSON.stringify({
          state: { cornerRadius: 'HIGH' },
          version: 0,
        }),
      )

      await useUiStore.persist.rehydrate()

      expect(useUiStore.getState().cornerRadius).toBe('high')
    })

    it("rehydrate keeps a valid stored 'high'", async () => {
      globalThis.localStorage.setItem(
        'memlore-ui',
        JSON.stringify({
          state: { cornerRadius: 'high' },
          version: 0,
        }),
      )

      await useUiStore.persist.rehydrate()

      expect(useUiStore.getState().cornerRadius).toBe('high')
    })
  })

  describe('theme rehydrate', () => {
    it('coerces a persisted system theme to dark', async () => {
      globalThis.localStorage.setItem(
        'memlore-ui',
        JSON.stringify({
          state: { theme: 'system' },
          version: 0,
        }),
      )

      await useUiStore.persist.rehydrate()

      expect(useUiStore.getState().theme).toBe('dark')
    })
  })

  describe('uiLanguage', () => {
    it('rehydrate coerces an unsupported stored uiLanguage to DEFAULT_LANGUAGE', async () => {
      globalThis.localStorage.setItem(
        'memlore-ui',
        JSON.stringify({
          state: { uiLanguage: 'fr' }, // unsupported
          version: 0,
        }),
      )

      await useUiStore.persist.rehydrate()

      expect(useUiStore.getState().uiLanguage).toBe('en')
    })

    it('rehydrate falls back to DEFAULT_LANGUAGE when uiLanguage is absent from an old persisted blob', async () => {
      globalThis.localStorage.setItem(
        'memlore-ui',
        JSON.stringify({
          state: { sidebarCollapsed: true }, // no uiLanguage key at all
          version: 0,
        }),
      )

      await expect(useUiStore.persist.rehydrate()).resolves.not.toThrow()

      expect(useUiStore.getState().uiLanguage).toBe('en')
    })
  })

  describe('addedProviders', () => {
    it('rehydrate coerces a non-array persisted value back to an empty array', async () => {
      globalThis.localStorage.setItem(
        'memlore-ui',
        JSON.stringify({
          state: { addedProviders: 'openai' }, // corrupted / legacy shape
          version: 0,
        }),
      )

      await useUiStore.persist.rehydrate()

      expect(useUiStore.getState().addedProviders).toEqual([])
    })

    it('rehydrate keeps a valid persisted array', async () => {
      globalThis.localStorage.setItem(
        'memlore-ui',
        JSON.stringify({
          state: { addedProviders: ['openai', 'ollama'] },
          version: 0,
        }),
      )

      await useUiStore.persist.rehydrate()

      expect(useUiStore.getState().addedProviders).toEqual(['openai', 'ollama'])
    })
  })

  // Journal filter is scoped per-view (like range/sort/lockFilter) so picking a
  // journal on one page never leaks into another — the reported bug.
  describe('entryListFilters — per-view journal scope', () => {
    it('setEntryListJournalId isolates the journal filter to its own view', () => {
      useUiStore.getState().setEntryListJournalId('all', 'journal-1')

      expect(getEntryListFilter(useUiStore.getState(), 'all').journalId).toBe('journal-1')
      // Other views must stay unaffected — this is the cross-page isolation.
      expect(getEntryListFilter(useUiStore.getState(), 'tags').journalId).toBeNull()
      expect(getEntryListFilter(useUiStore.getState(), 'onthisday').journalId).toBeNull()

      useUiStore.getState().setEntryListJournalId('tags', 'journal-2')

      expect(getEntryListFilter(useUiStore.getState(), 'all').journalId).toBe('journal-1')
      expect(getEntryListFilter(useUiStore.getState(), 'tags').journalId).toBe('journal-2')
    })
  })

  describe('markDeviceRemoved', () => {
    beforeEach(() => {
      vi.useFakeTimers()
      useUiStore.setState({ recentlyRemovedDevices: [] })
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('hides the id until the window ends', () => {
      useUiStore.getState().markDeviceRemoved('old-phone')
      expect(useUiStore.getState().recentlyRemovedDevices).toEqual(['old-phone'])

      vi.advanceTimersByTime(REMOVED_DEVICE_HIDE_MS - 1)
      expect(useUiStore.getState().recentlyRemovedDevices).toEqual(['old-phone'])

      vi.advanceTimersByTime(1)
      expect(useUiStore.getState().recentlyRemovedDevices).toEqual([])
    })

    it('gives a second removal of the same id its own window', () => {
      useUiStore.getState().markDeviceRemoved('old-phone')
      vi.advanceTimersByTime(REMOVED_DEVICE_HIDE_MS / 2)
      useUiStore.getState().markDeviceRemoved('old-phone')

      vi.advanceTimersByTime(REMOVED_DEVICE_HIDE_MS / 2)
      expect(useUiStore.getState().recentlyRemovedDevices).toEqual(['old-phone'])

      vi.advanceTimersByTime(REMOVED_DEVICE_HIDE_MS / 2)
      expect(useUiStore.getState().recentlyRemovedDevices).toEqual([])
    })
  })
})
