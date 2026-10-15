import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

describe('useCapabilities', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it('desktop: all capabilities true regardless of the store', async () => {
    vi.stubEnv('VITE_MEMLORE_PLATFORM', '')
    vi.resetModules()
    const { useCapabilities } = await import('./useCapabilities')
    const { useCapabilitiesStore } = await import('../stores/capabilitiesStore')
    useCapabilitiesStore.getState().setWrites(false)
    const { result } = renderHook(() => useCapabilities())
    expect(result.current.writes).toBe(true)
    expect(result.current.ai).toBe(true)
  })

  it('web: writes comes from the store, everything else false', async () => {
    vi.stubEnv('VITE_MEMLORE_PLATFORM', 'web')
    vi.resetModules()
    const { useCapabilities } = await import('./useCapabilities')
    const { useCapabilitiesStore } = await import('../stores/capabilitiesStore')
    useCapabilitiesStore.getState().setWrites(false)
    const { result } = renderHook(() => useCapabilities())
    expect(result.current.writes).toBe(false)
    expect(result.current.ai).toBe(false)
    act(() => useCapabilitiesStore.getState().setWrites(true))
    expect(result.current.writes).toBe(true)
    expect(result.current.ai).toBe(false)
  })

  it('desktop: runtime web flags never narrow anything', async () => {
    vi.stubEnv('VITE_MEMLORE_PLATFORM', '')
    vi.resetModules()
    const { useCapabilities } = await import('./useCapabilities')
    const { useCapabilitiesStore } = await import('../stores/capabilitiesStore')
    useCapabilitiesStore.getState().setWebCapabilities({ outboxV2: false, monthIndex: false })
    const { result } = renderHook(() => useCapabilities())
    for (const [flag, value] of Object.entries(result.current)) expect(value, flag).toBe(true)
  })

  it('web: a v2-only desktop enables no write flag (every web write seals frame 3)', async () => {
    vi.stubEnv('VITE_MEMLORE_PLATFORM', 'web')
    vi.resetModules()
    const { useCapabilities } = await import('./useCapabilities')
    const { useCapabilitiesStore } = await import('../stores/capabilitiesStore')
    const store = useCapabilitiesStore.getState()
    store.setWrites(true)
    store.setWebCapabilities({ outboxV2: true, monthIndex: false })
    const { result } = renderHook(() => useCapabilities())
    expect(result.current.taxonomyCreate).toBe(false)
    expect(result.current.deleteEntries).toBe(false)
    expect(result.current.taxonomyEdits).toBe(false)
    expect(result.current.trashManage).toBe(false)
    // The Trash list itself is readable on web.
    expect(result.current.trashView).toBe(true)
  })

  const GATED = {
    taxonomyCreate: ['upsert_journal', 'upsert_tag'],
    taxonomyEdits: ['upsert_journal', 'upsert_tag', 'delete_journal', 'delete_tag'],
    templates: ['upsert_template', 'delete_template'],
    deleteEntries: ['trash_entry'],
    trashManage: ['restore_entry', 'purge_entry', 'empty_trash'],
    entryLocation: ['set_entry_location'],
    fileAttachments: ['attach_media', 'delete_media'],
    mediaInsertionMode: ['set_media_insertion_mode'],
    memoryEdit: ['delete_memory_item'],
    personaEdit: ['update_persona'],
  } as const
  type Gated = keyof typeof GATED
  const ALL_KINDS = [...new Set(Object.values(GATED).flat())]

  /** The web build with `implemented` as its `WEB_IMPLEMENTED_KINDS`. */
  async function webWith(implemented: readonly string[]) {
    vi.stubEnv('VITE_MEMLORE_PLATFORM', 'web')
    vi.resetModules()
    vi.doMock('../lib/webImplementedKinds', () => ({
      WEB_IMPLEMENTED_KINDS: new Set(implemented),
    }))
    const { currentCapabilities } = await import('./useCapabilities')
    const { useCapabilitiesStore } = await import('../stores/capabilitiesStore')
    const store = useCapabilitiesStore.getState()
    const advertise = (outboxKinds: readonly string[]) =>
      store.setWebCapabilities({ outboxV2: false, monthIndex: false, outboxKinds })
    return { flag: (f: Gated) => currentCapabilities()[f], store, advertise }
  }

  it('web: a kind-gated flag needs writes AND each kind advertised AND implemented', async () => {
    for (const [flag, kinds] of Object.entries(GATED) as Array<[Gated, readonly string[]]>) {
      for (const missing of kinds) {
        // Implemented: needs every kind advertised, and writes.
        const web = await webWith(ALL_KINDS)
        web.store.setWrites(true)
        web.advertise(kinds)
        expect(web.flag(flag), flag).toBe(true)
        web.advertise(kinds.filter((k) => k !== missing))
        expect(web.flag(flag), `${flag} - advertised ${missing}`).toBe(false)
        web.advertise(kinds)
        web.store.setWrites(false)
        expect(web.flag(flag), `${flag} read-only`).toBe(false)
        // Advertised but not implemented.
        const partial = await webWith(ALL_KINDS.filter((k) => k !== missing))
        partial.store.setWrites(true)
        partial.advertise(ALL_KINDS)
        expect(partial.flag(flag), `${flag} - implemented ${missing}`).toBe(false)
      }
    }
    vi.doUnmock('../lib/webImplementedKinds')
  })

  it('web: dashboard, gallery, lookback, stats, mapView and versionsRead follow the month index', async () => {
    vi.stubEnv('VITE_MEMLORE_PLATFORM', 'web')
    vi.resetModules()
    const { useCapabilities } = await import('./useCapabilities')
    const { useCapabilitiesStore } = await import('../stores/capabilitiesStore')
    const store = useCapabilitiesStore.getState()
    store.setWebCapabilities({ outboxV2: true, monthIndex: false })
    const { result } = renderHook(() => useCapabilities())
    const indexed = [
      'dashboard',
      'gallery',
      'lookback',
      'stats',
      'mapView',
      'versionsRead',
    ] as const
    for (const flag of indexed) expect(result.current[flag], flag).toBe(false)
    act(() => store.setWebCapabilities({ outboxV2: false, monthIndex: true }))
    for (const flag of indexed) expect(result.current[flag], flag).toBe(true)
    // Version restore is not part of the index.
    expect(result.current.versions).toBe(false)
    // Location and weather writes stay desktop-only: only the map view follows the index.
    expect(result.current.maps).toBe(false)
  })

  it('currentCapabilities reads the store outside React, like the hook', async () => {
    vi.stubEnv('VITE_MEMLORE_PLATFORM', 'web')
    vi.resetModules()
    const { currentCapabilities, useCapabilities } = await import('./useCapabilities')
    const { useCapabilitiesStore } = await import('../stores/capabilitiesStore')
    const store = useCapabilitiesStore.getState()
    store.setWrites(true)
    store.setWebCapabilities({ outboxV2: false, monthIndex: false })
    expect(currentCapabilities().gallery).toBe(false)
    store.setWebCapabilities({ outboxV2: true, monthIndex: true })
    const { result } = renderHook(() => useCapabilities())
    expect(currentCapabilities()).toEqual(result.current)
    expect(currentCapabilities()).toMatchObject({ gallery: true, lookback: true, mapView: true })
  })

  it('currentCapabilities on desktop is the static set', async () => {
    vi.stubEnv('VITE_MEMLORE_PLATFORM', '')
    vi.resetModules()
    const { currentCapabilities } = await import('./useCapabilities')
    const { capabilities } = await import('../lib/platform')
    const { useCapabilitiesStore } = await import('../stores/capabilitiesStore')
    useCapabilitiesStore.getState().setWebCapabilities({ outboxV2: false, monthIndex: false })
    expect(currentCapabilities()).toBe(capabilities)
  })
})
