import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  useTabStore,
  makeDefaultTab,
  applyLaunchView,
  markLaunchViewApplied,
  __resetLaunchViewForTests,
} from './tabStore'
import type { Tab } from './tabStore'
import { useTabHistoryStore } from './tabHistoryStore'

function seedStore(tabs: Tab[], activeTabId: string) {
  useTabStore.setState({ tabs, activeTabId })
}

function makeTab(overrides: Partial<Tab> = {}): Tab {
  return {
    ...makeDefaultTab(),
    id: 'tab-default',
    dirty: false,
    ...overrides,
  }
}

beforeEach(() => {
  __resetLaunchViewForTests()
  // Reset to a known state with a single tab
  const tab = makeTab({ id: 'tab-1' })
  seedStore([tab], 'tab-1')
  useTabHistoryStore.setState({ histories: {}, isRestoring: false })
})

afterEach(() => {
  // Clean up localStorage between tests
  localStorage.clear()
})

describe('tabStore — synchronous initial state (pre-rehydrate)', () => {
  it('exports a fresh module instance that is never empty, even with empty localStorage', async () => {
    // Clear storage and reset module cache BEFORE importing.
    // This simulates a cold boot where no tabs have been persisted.
    localStorage.clear()
    vi.resetModules()

    const mod = await import('./tabStore')

    // Prove we got a genuinely fresh module instance (not the cached one).
    expect(mod.useTabStore).not.toBe(useTabStore)

    const state = mod.useTabStore.getState()
    expect(state.tabs.length).toBeGreaterThanOrEqual(1)
    expect(state.activeTabId).toBeTruthy()
    expect(state.tabs.find((t) => t.id === state.activeTabId)).toBeDefined()
  })
})

describe('newTab', () => {
  it('adds a tab and makes it active', () => {
    const { newTab } = useTabStore.getState()
    newTab()
    const state = useTabStore.getState()
    expect(state.tabs).toHaveLength(2)
    expect(state.activeTabId).toBe(state.tabs[1].id)
  })

  it('new tab clones journalId from active tab', () => {
    const tab = makeTab({ id: 'tab-1', journalId: 'journal-abc' })
    seedStore([tab], 'tab-1')
    const { newTab } = useTabStore.getState()
    newTab()
    const state = useTabStore.getState()
    expect(state.tabs[1].journalId).toBe('journal-abc')
  })

  it('ignores caller-supplied id override and assigns a fresh unique one', () => {
    const { newTab } = useTabStore.getState()
    newTab({ id: 'tab-1' }) // Try to clash with the existing seeded tab
    const state = useTabStore.getState()
    expect(state.tabs).toHaveLength(2)
    // All tab ids must still be unique
    const ids = state.tabs.map((t) => t.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('with background:true appends the tab but does NOT change activeTabId', () => {
    const tab = makeTab({ id: 'tab-1' })
    seedStore([tab], 'tab-1')
    const { newTab } = useTabStore.getState()
    newTab({ activeView: 'calendar' }, { background: true })
    const state = useTabStore.getState()
    expect(state.tabs).toHaveLength(2)
    expect(state.activeTabId).toBe('tab-1')
    expect(state.tabs[1].activeView).toBe('calendar')
  })
})

describe('closeTab', () => {
  it('focuses the first remaining tab when closing the active tab', () => {
    const t1 = makeTab({ id: 'tab-1' })
    const t2 = makeTab({ id: 'tab-2' })
    const t3 = makeTab({ id: 'tab-3' })
    seedStore([t1, t2, t3], 'tab-3')
    useTabStore.getState().closeTab('tab-3')
    const state = useTabStore.getState()
    expect(state.activeTabId).toBe('tab-1')
    expect(state.tabs).toHaveLength(2)
  })

  it('closing the only tab is a no-op', () => {
    const t1 = makeTab({ id: 'tab-1' })
    seedStore([t1], 'tab-1')
    useTabStore.getState().closeTab('tab-1')
    const state = useTabStore.getState()
    expect(state.tabs).toHaveLength(1)
    expect(state.activeTabId).toBe('tab-1')
  })

  it('closing a non-active tab does not change activeTabId', () => {
    const t1 = makeTab({ id: 'tab-1' })
    const t2 = makeTab({ id: 'tab-2' })
    seedStore([t1, t2], 'tab-1')
    useTabStore.getState().closeTab('tab-2')
    const state = useTabStore.getState()
    expect(state.activeTabId).toBe('tab-1')
    expect(state.tabs).toHaveLength(1)
  })

  it('closing the active unpinned tab focuses the first tab in the list — even if it is pinned', () => {
    const p1 = makeTab({ id: 'pin-1', pinned: true })
    const u1 = makeTab({ id: 'un-1' })
    const u2 = makeTab({ id: 'un-2' })
    seedStore([p1, u1, u2], 'un-2')
    useTabStore.getState().closeTab('un-2')
    // Spec says "first tab in the list" — that's pin-1, regardless of
    // partition. User explicitly chose this behavior when designing the
    // feature.
    expect(useTabStore.getState().activeTabId).toBe('pin-1')
  })
})

describe('setActiveTab', () => {
  it('unknown id is a no-op', () => {
    useTabStore.getState().setActiveTab('does-not-exist')
    expect(useTabStore.getState().activeTabId).toBe('tab-1')
  })
})

describe('updateActiveTab', () => {
  it('mutates only the active tab', () => {
    const t1 = makeTab({ id: 'tab-1', selectedEntryId: null })
    const t2 = makeTab({ id: 'tab-2', selectedEntryId: null })
    seedStore([t1, t2], 'tab-1')
    useTabStore.getState().updateActiveTab({ selectedEntryId: 'entry-abc' })
    const state = useTabStore.getState()
    expect(state.tabs[0].selectedEntryId).toBe('entry-abc')
    expect(state.tabs[1].selectedEntryId).toBeNull()
  })
})

describe('switchByIndex', () => {
  it('switches to tab at index 1 (⌘2)', () => {
    const t1 = makeTab({ id: 'tab-1' })
    const t2 = makeTab({ id: 'tab-2' })
    seedStore([t1, t2], 'tab-1')
    useTabStore.getState().switchByIndex(1)
    expect(useTabStore.getState().activeTabId).toBe('tab-2')
  })

  it('out-of-range index is a no-op', () => {
    useTabStore.getState().switchByIndex(99)
    expect(useTabStore.getState().activeTabId).toBe('tab-1')
  })
})

describe('reorderTab', () => {
  it('moves a tab forward (index 0 → 2)', () => {
    const t1 = makeTab({ id: 'tab-1' })
    const t2 = makeTab({ id: 'tab-2' })
    const t3 = makeTab({ id: 'tab-3' })
    seedStore([t1, t2, t3], 'tab-1')
    useTabStore.getState().reorderTab('tab-1', 2)
    const ids = useTabStore.getState().tabs.map((t) => t.id)
    expect(ids).toEqual(['tab-2', 'tab-3', 'tab-1'])
  })

  it('preserves activeTabId — moves the tab, not the focus', () => {
    const t1 = makeTab({ id: 'tab-1' })
    const t2 = makeTab({ id: 'tab-2' })
    const t3 = makeTab({ id: 'tab-3' })
    seedStore([t1, t2, t3], 'tab-2')
    useTabStore.getState().reorderTab('tab-1', 2)
    expect(useTabStore.getState().activeTabId).toBe('tab-2')
  })

  it('toIndex beyond end clamps to last valid index', () => {
    const t1 = makeTab({ id: 'tab-1' })
    const t2 = makeTab({ id: 'tab-2' })
    const t3 = makeTab({ id: 'tab-3' })
    seedStore([t1, t2, t3], 'tab-1')
    useTabStore.getState().reorderTab('tab-1', 99)
    const ids = useTabStore.getState().tabs.map((t) => t.id)
    expect(ids).toEqual(['tab-2', 'tab-3', 'tab-1'])
  })

  it('new order survives persist round-trip via localStorage', async () => {
    const t1 = makeTab({ id: 'tab-1' })
    const t2 = makeTab({ id: 'tab-2' })
    const t3 = makeTab({ id: 'tab-3' })
    seedStore([t1, t2, t3], 'tab-1')
    useTabStore.getState().reorderTab('tab-1', 2)
    // Persist middleware writes synchronously after the set() call. Read it
    // back and verify the order is reflected on disk.
    const stored = localStorage.getItem('memlore-tabs')
    expect(stored).not.toBeNull()
    if (!stored) return
    const parsed = JSON.parse(stored) as { state: { tabs: Tab[]; activeTabId: string } }
    expect(parsed.state.tabs.map((t) => t.id)).toEqual(['tab-2', 'tab-3', 'tab-1'])
    expect(parsed.state.activeTabId).toBe('tab-1')
  })
})

describe('duplicateTab', () => {
  it('clones every view-state field and inserts the clone after the source', () => {
    const t1 = makeTab({
      id: 'tab-1',
      journalId: 'j-source',
      activeView: 'settings',
      selectedEntryId: 'e-99',
      selectedCalendarDate: '2026-04-14',
      selectedTagId: 't-7',
      selectedChatSessionId: 'chat-42',
      pagination: { all: 3, 'favorites:all': 2 },
      settingsCategory: 'ai',
      securityTab: 'second_lock',
      locationTab: 'saved',
      aiTab: 'features',
      templatesTab: 'builtin',
      dataTab: 'export',
      editorTab: 'font',
      syncTab: 'schedule',
      statsTab: 'usage',
    })
    const t2 = makeTab({ id: 'tab-2' })
    seedStore([t1, t2], 'tab-1')
    useTabStore.getState().duplicateTab('tab-1')
    const state = useTabStore.getState()
    expect(state.tabs).toHaveLength(3)
    const clone = state.tabs[1]
    expect(clone.id).not.toBe('tab-1')
    expect(clone.journalId).toBe('j-source')
    expect(clone.activeView).toBe('settings')
    expect(clone.selectedEntryId).toBe('e-99')
    expect(clone.selectedCalendarDate).toBe('2026-04-14')
    expect(clone.selectedTagId).toBe('t-7')
    expect(clone.selectedChatSessionId).toBe('chat-42')
    expect(clone.pagination).toEqual({ all: 3, 'favorites:all': 2 })
    expect(clone.settingsCategory).toBe('ai')
    expect(clone.securityTab).toBe('second_lock')
    expect(clone.locationTab).toBe('saved')
    expect(clone.aiTab).toBe('features')
    expect(clone.templatesTab).toBe('builtin')
    expect(clone.dataTab).toBe('export')
    expect(clone.editorTab).toBe('font')
    expect(clone.syncTab).toBe('schedule')
    expect(clone.statsTab).toBe('usage')
    // tab-2 is pushed to index 2
    expect(state.tabs[2].id).toBe('tab-2')
  })

  it('clone of a pinned source lands at the start of the unpinned cluster', () => {
    const p1 = makeTab({ id: 'pin-1', pinned: true })
    const p2 = makeTab({ id: 'pin-2', pinned: true })
    const u1 = makeTab({ id: 'un-1' })
    seedStore([p1, p2, u1], 'pin-1')
    useTabStore.getState().duplicateTab('pin-1')
    const state = useTabStore.getState()
    // [pin-1, pin-2, clone(unpinned), un-1]
    expect(state.tabs[0].id).toBe('pin-1')
    expect(state.tabs[1].id).toBe('pin-2')
    expect(state.tabs[2].pinned).not.toBe(true)
    expect(state.tabs[3].id).toBe('un-1')
  })

  it('deep-clones pagination — mutating the clone does not affect the source', () => {
    const t1 = makeTab({ id: 'tab-1', pagination: { all: 5 } })
    seedStore([t1], 'tab-1')
    useTabStore.getState().duplicateTab('tab-1')
    const cloneId = useTabStore.getState().activeTabId
    useTabStore.getState().setTabPage(cloneId, 'all', 9)
    const after = useTabStore.getState().tabs
    expect(after.find((t) => t.id === 'tab-1')?.pagination?.['all']).toBe(5)
    expect(after.find((t) => t.id === cloneId)?.pagination?.['all']).toBe(9)
  })
})

describe('togglePinTab', () => {
  it('pinning moves the tab to the end of the pinned cluster', () => {
    const p1 = makeTab({ id: 'pin-1', pinned: true })
    const u1 = makeTab({ id: 'un-1' })
    const u2 = makeTab({ id: 'un-2' })
    seedStore([p1, u1, u2], 'un-2')
    useTabStore.getState().togglePinTab('un-2')
    const ids = useTabStore.getState().tabs.map((t) => t.id)
    expect(ids).toEqual(['pin-1', 'un-2', 'un-1'])
    expect(useTabStore.getState().tabs[1].pinned).toBe(true)
  })

  it('unpinning moves the tab to the start of the unpinned cluster', () => {
    const p1 = makeTab({ id: 'pin-1', pinned: true })
    const p2 = makeTab({ id: 'pin-2', pinned: true })
    const u1 = makeTab({ id: 'un-1' })
    seedStore([p1, p2, u1], 'pin-1')
    useTabStore.getState().togglePinTab('pin-1')
    const ids = useTabStore.getState().tabs.map((t) => t.id)
    expect(ids).toEqual(['pin-2', 'pin-1', 'un-1'])
    expect(useTabStore.getState().tabs.find((t) => t.id === 'pin-1')?.pinned).toBe(false)
  })

  it('preserves activeTabId across the toggle', () => {
    const p1 = makeTab({ id: 'pin-1', pinned: true })
    const u1 = makeTab({ id: 'un-1' })
    seedStore([p1, u1], 'pin-1')
    useTabStore.getState().togglePinTab('un-1')
    expect(useTabStore.getState().activeTabId).toBe('pin-1')
  })
})

describe('reorderTab — pinned partition', () => {
  it('cannot move an unpinned tab into the pinned cluster (clamped)', () => {
    const p1 = makeTab({ id: 'pin-1', pinned: true })
    const u1 = makeTab({ id: 'un-1' })
    const u2 = makeTab({ id: 'un-2' })
    seedStore([p1, u1, u2], 'un-2')
    // Try to drag un-2 to index 0 — should clamp to index 1 (start of unpinned)
    useTabStore.getState().reorderTab('un-2', 0)
    const ids = useTabStore.getState().tabs.map((t) => t.id)
    expect(ids).toEqual(['pin-1', 'un-2', 'un-1'])
  })

  it('cannot move a pinned tab into the unpinned cluster (clamped)', () => {
    const p1 = makeTab({ id: 'pin-1', pinned: true })
    const p2 = makeTab({ id: 'pin-2', pinned: true })
    const u1 = makeTab({ id: 'un-1' })
    seedStore([p1, p2, u1], 'pin-1')
    // Try to drag pin-1 to index 2 — clamps to 1 (end of pinned)
    useTabStore.getState().reorderTab('pin-1', 2)
    const ids = useTabStore.getState().tabs.map((t) => t.id)
    expect(ids).toEqual(['pin-2', 'pin-1', 'un-1'])
  })
})

describe('persist round-trip', () => {
  it('serializes tabs to localStorage under memlore-tabs key', () => {
    const tab = makeTab({ id: 'persist-tab', journalId: 'j1', activeView: 'calendar' })
    seedStore([tab], 'persist-tab')
    // Trigger persist by calling any action
    useTabStore.getState().updateActiveTab({ selectedEntryId: 'e1' })
    // Check localStorage contains key
    const stored = localStorage.getItem('memlore-tabs')
    expect(stored).not.toBeNull()
    if (!stored) return
    const parsed = JSON.parse(stored) as { state: { tabs: Tab[]; activeTabId: string } }
    expect(parsed.state.tabs[0].id).toBe('persist-tab')
    expect(parsed.state.tabs[0].journalId).toBe('j1')
    expect(parsed.state.activeTabId).toBe('persist-tab')
  })

  it('stored payload state keys are only tabs and activeTabId', () => {
    useTabStore.getState().updateActiveTab({ selectedEntryId: 'e1' })
    const stored = localStorage.getItem('memlore-tabs')
    expect(stored).not.toBeNull()
    if (!stored) return
    const parsed = JSON.parse(stored) as { state: Record<string, unknown>; version: unknown }
    expect(Object.keys(parsed)).toEqual(expect.arrayContaining(['state', 'version']))
    expect(Object.keys(parsed.state).sort()).toEqual(['activeTabId', 'tabs'])
    expect(Array.isArray(parsed.state.tabs)).toBe(true)
    expect(typeof parsed.state.activeTabId).toBe('string')
  })

  it('a dirty tab serializes with dirty not true', () => {
    useTabStore.getState().updateActiveTab({ dirty: true })
    expect(useTabStore.getState().tabs[0].dirty).toBe(true)
    const stored = localStorage.getItem('memlore-tabs')
    expect(stored).not.toBeNull()
    if (!stored) return
    const parsed = JSON.parse(stored) as { state: { tabs: Tab[] } }
    expect(parsed.state.tabs[0].dirty).not.toBe(true)
  })

  it('a draft chat selection serializes as not-draft with a null session id', () => {
    useTabStore.getState().updateActiveTab({
      selectedChatSessionIsDraft: true,
      selectedChatSessionId: 'draft-sess',
    })
    expect(useTabStore.getState().tabs[0].selectedChatSessionIsDraft).toBe(true)
    expect(useTabStore.getState().tabs[0].selectedChatSessionId).toBe('draft-sess')
    const stored = localStorage.getItem('memlore-tabs')
    expect(stored).not.toBeNull()
    if (!stored) return
    const parsed = JSON.parse(stored) as { state: { tabs: Tab[] } }
    expect(parsed.state.tabs[0].selectedChatSessionIsDraft).not.toBe(true)
    expect(parsed.state.tabs[0].selectedChatSessionId).toBeNull()
  })
})

describe('setTabPage', () => {
  it('does not touch other view keys on the same tab', () => {
    useTabStore.getState().setTabPage('tab-1', 'favorites:all', 2)
    useTabStore.getState().setTabPage('tab-1', 'all', 5)
    const tab = useTabStore.getState().tabs.find((t) => t.id === 'tab-1')
    expect(tab?.pagination?.['favorites:all']).toBe(2)
    expect(tab?.pagination?.['all']).toBe(5)
  })

  it('does not touch other tabs', () => {
    const t2 = makeTab({ id: 'tab-2' })
    const { tabs, activeTabId } = useTabStore.getState()
    seedStore([...tabs, t2], activeTabId)

    useTabStore.getState().setTabPage('tab-1', 'all', 7)
    const tab2 = useTabStore.getState().tabs.find((t) => t.id === 'tab-2')
    expect(tab2?.pagination).toBeUndefined()
  })

  it('clamps page to ≥ 1 when 0 is passed', () => {
    useTabStore.getState().setTabPage('tab-1', 'all', 0)
    const tab = useTabStore.getState().tabs.find((t) => t.id === 'tab-1')
    expect(tab?.pagination?.['all']).toBe(1)
  })
})

describe('seeding on rehydrate', () => {
  it('seeds a default tab when localStorage is empty', async () => {
    localStorage.clear()
    // Force rehydrate
    await useTabStore.persist.rehydrate()
    const state = useTabStore.getState()
    expect(state.tabs.length).toBeGreaterThanOrEqual(1)
    expect(state.activeTabId).toBeTruthy()
    expect(state.tabs.find((t) => t.id === state.activeTabId)).toBeDefined()
  })

  it('restores existing tabs from localStorage on rehydrate', async () => {
    // Seed state into localStorage
    const tab = makeTab({ id: 'stored-tab', journalId: 'j-stored', activeView: 'calendar' })
    const storedData = {
      state: { tabs: [tab], activeTabId: 'stored-tab' },
      version: 0,
    }
    localStorage.setItem('memlore-tabs', JSON.stringify(storedData))
    await useTabStore.persist.rehydrate()
    const state = useTabStore.getState()
    expect(state.tabs.some((t) => t.id === 'stored-tab')).toBe(true)
    expect(state.activeTabId).toBe('stored-tab')
  })

  it('backfills selectedChatSessionId when older persisted tabs omit the field', async () => {
    // Simulate a tab written before selectedChatSessionId existed.
    const legacyTab = {
      id: 'legacy-tab',
      journalId: null,
      activeView: 'chat' as const,
      selectedEntryId: null,
      selectedCalendarDate: null,
      selectedTagId: null,
      // intentionally omit selectedChatSessionId
      dirty: false,
      pinned: false,
    }
    localStorage.setItem(
      'memlore-tabs',
      JSON.stringify({ state: { tabs: [legacyTab], activeTabId: 'legacy-tab' }, version: 0 }),
    )
    await useTabStore.persist.rehydrate()
    const tab = useTabStore.getState().tabs.find((t) => t.id === 'legacy-tab')
    expect(tab?.selectedChatSessionId).toBeNull()
  })

  it('backfills settings/stats nav defaults when older persisted tabs omit the fields', async () => {
    const legacyTab = {
      id: 'legacy-settings-tab',
      journalId: null,
      activeView: 'settings' as const,
      selectedEntryId: null,
      selectedCalendarDate: null,
      selectedTagId: null,
      selectedChatSessionId: null,
      dirty: false,
      pinned: false,
      // intentionally omit settingsCategory / sub-tabs / statsTab
    }
    localStorage.setItem(
      'memlore-tabs',
      JSON.stringify({
        state: { tabs: [legacyTab], activeTabId: 'legacy-settings-tab' },
        version: 0,
      }),
    )
    await useTabStore.persist.rehydrate()
    const tab = useTabStore.getState().tabs.find((t) => t.id === 'legacy-settings-tab')
    expect(tab?.settingsCategory).toBe('security')
    expect(tab?.securityTab).toBe('device_password')
    expect(tab?.locationTab).toBe('geocoding')
    expect(tab?.aiTab).toBe('chat')
    expect(tab?.templatesTab).toBe('custom')
    expect(tab?.dataTab).toBe('import')
    expect(tab?.editorTab).toBe('general')
    expect(tab?.syncTab).toBe('gdrive')
    expect(tab?.statsTab).toBe('charts')
  })

  it('rehydrate coerces unknown settings/stats enum values and migrates embed→chat', async () => {
    const badTab = {
      id: 'bad-tab',
      journalId: null,
      activeView: 'settings' as const,
      selectedEntryId: null,
      selectedCalendarDate: null,
      selectedTagId: null,
      selectedChatSessionId: null,
      dirty: false,
      pinned: false,
      settingsCategory: 'legacy-tags',
      securityTab: 'secret-stuff',
      locationTab: 'foo',
      aiTab: 'embed',
      templatesTab: 'baz',
      dataTab: 'qux',
      editorTab: 'legacy',
      syncTab: 'legacy',
      statsTab: 'legacy',
    }
    localStorage.setItem(
      'memlore-tabs',
      JSON.stringify({ state: { tabs: [badTab], activeTabId: 'bad-tab' }, version: 0 }),
    )
    await useTabStore.persist.rehydrate()
    const tab = useTabStore.getState().tabs.find((t) => t.id === 'bad-tab')
    expect(tab?.settingsCategory).toBe('appearance')
    expect(tab?.securityTab).toBe('device_password')
    expect(tab?.locationTab).toBe('geocoding')
    expect(tab?.aiTab).toBe('chat')
    expect(tab?.templatesTab).toBe('custom')
    expect(tab?.dataTab).toBe('import')
    expect(tab?.editorTab).toBe('general')
    expect(tab?.appearanceTab).toBe('theme')
    expect(tab?.syncTab).toBe('gdrive')
    expect(tab?.statsTab).toBe('charts')
  })

  it('rehydrate keeps a persisted appearanceTab of layout', async () => {
    const layoutTab = {
      id: 'layout-tab',
      journalId: null,
      activeView: 'settings' as const,
      selectedEntryId: null,
      selectedCalendarDate: null,
      selectedTagId: null,
      selectedChatSessionId: null,
      dirty: false,
      pinned: false,
      settingsCategory: 'appearance',
      appearanceTab: 'layout',
    }
    localStorage.setItem(
      'memlore-tabs',
      JSON.stringify({
        state: { tabs: [layoutTab], activeTabId: 'layout-tab' },
        version: 0,
      }),
    )
    await useTabStore.persist.rehydrate()
    const tab = useTabStore.getState().tabs.find((t) => t.id === 'layout-tab')
    expect(tab?.appearanceTab).toBe('layout')
  })

  it('rehydrate keeps a persisted dataTab of downloads', async () => {
    const downloadsTab = {
      id: 'downloads-tab',
      journalId: null,
      activeView: 'settings' as const,
      selectedEntryId: null,
      selectedCalendarDate: null,
      selectedTagId: null,
      selectedChatSessionId: null,
      dirty: false,
      pinned: false,
      settingsCategory: 'data',
      dataTab: 'downloads',
    }
    localStorage.setItem(
      'memlore-tabs',
      JSON.stringify({
        state: { tabs: [downloadsTab], activeTabId: 'downloads-tab' },
        version: 0,
      }),
    )
    await useTabStore.persist.rehydrate()
    const tab = useTabStore.getState().tabs.find((t) => t.id === 'downloads-tab')
    expect(tab?.dataTab).toBe('downloads')
    expect(tab?.settingsCategory).toBe('data')
  })

  it('seeds a default tab when persisted tabs array is empty', async () => {
    localStorage.setItem(
      'memlore-tabs',
      JSON.stringify({ state: { tabs: [], activeTabId: 'gone' }, version: 0 }),
    )
    await useTabStore.persist.rehydrate()
    const state = useTabStore.getState()
    expect(state.tabs.length).toBeGreaterThanOrEqual(1)
    expect(state.activeTabId).toBe(state.tabs[0].id)
  })

  it('falls back to the first tab when persisted activeTabId is missing', async () => {
    const t1 = makeTab({ id: 'tab-a' })
    const t2 = makeTab({ id: 'tab-b' })
    localStorage.setItem(
      'memlore-tabs',
      JSON.stringify({ state: { tabs: [t1, t2], activeTabId: 'missing-id' }, version: 0 }),
    )
    await useTabStore.persist.rehydrate()
    const state = useTabStore.getState()
    expect(state.tabs).toHaveLength(2)
    expect(state.tabs.map((t) => t.id)).toEqual(['tab-a', 'tab-b'])
    expect(state.activeTabId).toBe(state.tabs[0].id)
  })

  it('clears legacy dirty:true on rehydrate so relaunch cannot flash saving', async () => {
    const tab = makeTab({ id: 'dirty-tab', dirty: true })
    localStorage.setItem(
      'memlore-tabs',
      JSON.stringify({ state: { tabs: [tab], activeTabId: 'dirty-tab' }, version: 0 }),
    )
    await useTabStore.persist.rehydrate()
    const restored = useTabStore.getState().tabs.find((t) => t.id === 'dirty-tab')
    expect(restored?.dirty).not.toBe(true)
  })

  it('treats corrupt JSON as a miss, finishes hydration, and keeps a seed tab', async () => {
    localStorage.setItem('memlore-tabs', '{not json')
    await expect(useTabStore.persist.rehydrate()).resolves.toBeUndefined()
    expect(useTabStore.persist.hasHydrated()).toBe(true)
    const state = useTabStore.getState()
    expect(state.tabs.length).toBeGreaterThanOrEqual(1)
    expect(state.tabs.find((t) => t.id === state.activeTabId)).toBeDefined()
  })

  it('seeds a default tab when persisted tabs is not an array', async () => {
    localStorage.setItem(
      'memlore-tabs',
      JSON.stringify({ state: { tabs: null, activeTabId: 'x' }, version: 0 }),
    )
    await expect(useTabStore.persist.rehydrate()).resolves.toBeUndefined()
    expect(useTabStore.persist.hasHydrated()).toBe(true)
    const state = useTabStore.getState()
    expect(Array.isArray(state.tabs)).toBe(true)
    expect(state.tabs.length).toBeGreaterThanOrEqual(1)
    expect(state.activeTabId).toBe(state.tabs[0].id)
  })
})

describe('tabStore — history integration', () => {
  it('updateActiveTab pushes nav-relevant change onto back stack', () => {
    useTabStore.getState().updateActiveTab({ activeView: 'calendar' })
    const hist = useTabHistoryStore.getState().histories['tab-1']
    expect(hist?.back).toHaveLength(1)
    expect(hist?.back[0].activeView).toBe('dashboard')
  })

  it('pushes and restores selectedChatSessionId via history (mouse back regression)', () => {
    // Chat tab with a conversation open, then navigate to settings (as sidebar does).
    useTabStore.getState().updateActiveTab({
      activeView: 'chat',
      selectedChatSessionId: 'sess-open',
    })
    useTabStore.getState().updateActiveTab({ activeView: 'settings', selectedEntryId: null })
    const hist = useTabHistoryStore.getState().histories['tab-1']
    expect(hist?.back.at(-1)?.activeView).toBe('chat')
    expect(hist?.back.at(-1)?.selectedChatSessionId).toBe('sess-open')

    // Simulate goBack: pop the previous snapshot and restore it.
    const current = useTabStore.getState().tabs[0]
    const target = useTabHistoryStore.getState().popBack('tab-1', {
      journalId: current.journalId,
      activeView: current.activeView,
      selectedEntryId: current.selectedEntryId,
      selectedCalendarDate: current.selectedCalendarDate,
      selectedTagId: current.selectedTagId,
      selectedChatSessionId: current.selectedChatSessionId,
      pagination: current.pagination,
      settingsCategory: current.settingsCategory,
      securityTab: current.securityTab,
      locationTab: current.locationTab,
      aiTab: current.aiTab,
      templatesTab: current.templatesTab,
      dataTab: current.dataTab,
      editorTab: current.editorTab,
      syncTab: current.syncTab,
      statsTab: current.statsTab,
    })
    expect(target).not.toBeNull()
    useTabHistoryStore.getState().setRestoring(true)
    try {
      useTabStore.getState().updateActiveTab(target!)
    } finally {
      useTabHistoryStore.getState().setRestoring(false)
    }
    const restored = useTabStore.getState().tabs[0]
    expect(restored.activeView).toBe('chat')
    expect(restored.selectedChatSessionId).toBe('sess-open')
  })

  it('updateActiveTab does NOT push for dirty-only patch (regression: C1)', () => {
    useTabStore.getState().updateActiveTab({ dirty: true })
    useTabStore.getState().updateActiveTab({ dirty: false })
    const hist = useTabHistoryStore.getState().histories['tab-1']
    // No nav fields changed → no history entries at all
    expect(hist).toBeUndefined()
  })

  it('updateActiveTab does NOT push for settingsAnchor-only patch', () => {
    useTabStore.getState().updateActiveTab({ settingsAnchor: 'settings-anchor-accent-color' })
    const hist = useTabHistoryStore.getState().histories['tab-1']
    expect(hist).toBeUndefined()
  })

  it('updateActiveTab skips push while isRestoring is true', () => {
    useTabHistoryStore.getState().setRestoring(true)
    useTabStore.getState().updateActiveTab({ activeView: 'calendar' })
    useTabHistoryStore.getState().setRestoring(false)
    expect(useTabHistoryStore.getState().histories['tab-1']).toBeUndefined()
  })

  it('closeTab clears that tab’s history', () => {
    const tabA = makeTab({ id: 'tab-A' })
    const tabB = makeTab({ id: 'tab-B' })
    seedStore([tabA, tabB], 'tab-A')
    useTabStore.getState().updateActiveTab({ activeView: 'calendar' })
    expect(useTabHistoryStore.getState().histories['tab-A']).toBeDefined()
    useTabStore.getState().closeTab('tab-A')
    expect(useTabHistoryStore.getState().histories['tab-A']).toBeUndefined()
  })

  it('setTabPage pushes prior pagination snapshot for the active tab', () => {
    useTabStore.getState().setTabPage('tab-1', 'all', 3)
    const hist = useTabHistoryStore.getState().histories['tab-1']
    expect(hist?.back).toHaveLength(1)
    // Snapshot reflects pre-change state (no pagination set yet)
    expect(hist?.back[0].pagination).toBeUndefined()
  })

  it('setTabPage to the same already-stored page does not push', () => {
    // Seed pagination so the stored value matches what we then set
    useTabStore.getState().setTabPage('tab-1', 'all', 1)
    // Clear history from that first push so the no-op assertion is clean
    useTabHistoryStore.setState({ histories: {} })
    useTabStore.getState().setTabPage('tab-1', 'all', 1)
    expect(useTabHistoryStore.getState().histories['tab-1']).toBeUndefined()
  })
})

describe('applyLaunchView', () => {
  it("flips only the active tab's activeView to dashboard", () => {
    const active = makeTab({
      id: 'tab-1',
      activeView: 'entries',
      selectedEntryId: 'entry-keep',
      pinned: true,
    })
    const inactive = makeTab({
      id: 'tab-2',
      activeView: 'calendar',
      selectedEntryId: 'entry-other',
    })
    seedStore([active, inactive], 'tab-1')

    applyLaunchView()

    const state = useTabStore.getState()
    expect(state.tabs[0].id).toBe('tab-1')
    expect(state.tabs[0].activeView).toBe('dashboard')
    expect(state.tabs[1].id).toBe('tab-2')
    expect(state.tabs[1].activeView).toBe('calendar')
  })

  it('keeps selectedEntryId, pinned, tab order, and inactive tabs', () => {
    const active = makeTab({
      id: 'tab-1',
      activeView: 'stats',
      selectedEntryId: 'entry-keep',
      pinned: true,
      journalId: 'journal-a',
    })
    const inactive = makeTab({
      id: 'tab-2',
      activeView: 'calendar',
      selectedEntryId: 'entry-other',
      pinned: false,
    })
    seedStore([active, inactive], 'tab-1')

    applyLaunchView()

    const state = useTabStore.getState()
    expect(state.tabs.map((t) => t.id)).toEqual(['tab-1', 'tab-2'])
    expect(state.activeTabId).toBe('tab-1')
    expect(state.tabs[0].selectedEntryId).toBe('entry-keep')
    expect(state.tabs[0].pinned).toBe(true)
    expect(state.tabs[0].journalId).toBe('journal-a')
    expect(state.tabs[1].activeView).toBe('calendar')
    expect(state.tabs[1].selectedEntryId).toBe('entry-other')
    expect(state.tabs[1].pinned).toBe(false)
  })

  it('second call is a no-op even after the user navigated away', () => {
    applyLaunchView()
    expect(useTabStore.getState().tabs[0].activeView).toBe('dashboard')

    useTabStore.getState().updateActiveTab({ activeView: 'entries' })
    expect(useTabStore.getState().tabs[0].activeView).toBe('entries')

    applyLaunchView()
    expect(useTabStore.getState().tabs[0].activeView).toBe('entries')
  })

  it('does not push a tabHistoryStore entry', () => {
    useTabStore.getState().updateActiveTab({ activeView: 'calendar' })
    const before = structuredClone(useTabHistoryStore.getState().histories)

    applyLaunchView()

    expect(useTabStore.getState().tabs[0].activeView).toBe('dashboard')
    expect(useTabHistoryStore.getState().histories).toEqual(before)
  })

  it('markLaunchViewApplied makes a later applyLaunchView a no-op', () => {
    seedStore([makeTab({ id: 'tab-1', activeView: 'entries' })], 'tab-1')
    expect(useTabStore.getState().tabs[0].activeView).toBe('entries')
    markLaunchViewApplied()
    applyLaunchView()
    expect(useTabStore.getState().tabs[0].activeView).toBe('entries')
  })

  it('does not rewrite tabs when the active tab is already dashboard, but still sets the flag', () => {
    const tab = makeTab({ id: 'tab-1', activeView: 'dashboard', selectedEntryId: 'entry-keep' })
    seedStore([tab], 'tab-1')
    const before = useTabStore.getState().tabs

    applyLaunchView()

    expect(useTabStore.getState().tabs).toBe(before)
    expect(useTabStore.getState().tabs[0].activeView).toBe('dashboard')
    expect(useTabStore.getState().tabs[0].selectedEntryId).toBe('entry-keep')

    useTabStore.getState().updateActiveTab({ activeView: 'entries' })
    applyLaunchView()
    expect(useTabStore.getState().tabs[0].activeView).toBe('entries')
  })
})
